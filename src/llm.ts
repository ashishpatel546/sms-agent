import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionFunctionTool,
} from 'openai/resources/chat/completions';
import type { Config } from './config.js';

export type Message = ChatCompletionMessageParam;
export type ModelTool = ChatCompletionFunctionTool;

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments as the model produced them. */
  arguments: string;
}

export interface TokenUsage {
  /** Prompt tokens that were not served from the provider's prompt cache. */
  input: number;
  cached: number;
  output: number;
}

export interface ModelTurn {
  content: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  /** The model that answered (may differ from the one asked for). */
  model?: string;
}

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

/** A model chosen for this request (the hub's choice via sms-backend). */
export interface ModelChoice {
  name: string;
  reasoningEffort?: ReasoningEffort | null;
}

export interface ModelRequest {
  messages: Message[];
  tools: ModelTool[];
  /** Routes requests with the same prefix to the same prompt cache. */
  cacheKey: string;
  /** Overrides AGENT_MODEL for this request. */
  model?: ModelChoice;
  signal?: AbortSignal;
}

/** The model the agent loop talks to — faked in tests. */
export interface ChatModel {
  readonly name: string;
  complete(req: ModelRequest, onText: (delta: string) => void): Promise<ModelTurn>;
}

/** A provider failure worth telling the user about in plain words. */
export class ModelError extends Error {}

export const emptyUsage = (): TokenUsage => ({ input: 0, cached: 0, output: 0 });

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    cached: a.cached + b.cached,
    output: a.output + b.output,
  };
}

export const isReasoningModel = (model: string) => /^(gpt-5|o\d)/.test(model);

/** OpenAI Chat Completions with streaming text and tool calls. */
export class OpenAiChatModel implements ChatModel {
  private readonly client: OpenAI;
  readonly name: string;

  constructor(private readonly config: Config) {
    this.client = new OpenAI({
      apiKey: config.openaiApiKey,
      maxRetries: 1,
      timeout: 60_000,
    });
    this.name = config.model;
  }

  async complete(
    req: ModelRequest,
    onText: (delta: string) => void,
  ): Promise<ModelTurn> {
    const fallback: ModelChoice = {
      name: this.config.model,
      reasoningEffort: this.config.reasoningEffort,
    };
    let choice = req.model ?? fallback;
    const open = (c: ModelChoice) =>
      this.client.chat.completions.create(
        {
          model: c.name,
          messages: req.messages,
          tools: req.tools.length ? req.tools : undefined,
          parallel_tool_calls: req.tools.length ? true : undefined,
          // Only reasoning models (gpt-5*, o-series) accept this parameter.
          ...(isReasoningModel(c.name)
            ? { reasoning_effort: c.reasoningEffort ?? this.config.reasoningEffort }
            : {}),
          max_completion_tokens: this.config.maxOutputTokens,
          prompt_cache_key: req.cacheKey,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: req.signal },
      );
    let stream;
    try {
      stream = await open(choice);
    } catch (err) {
      // A model chosen in the hub that this API key cannot use (or that
      // rejects a parameter) must not take the assistant down: answer with
      // the host's own model instead, and say so in the log.
      if (!isModelRejection(err) || choice.name === fallback.name) throw toModelError(err);
      console.error(
        `[sms-agent] model ${choice.name} refused (${(err as { status?: number }).status}); using ${fallback.name}`,
      );
      choice = fallback;
      try {
        stream = await open(choice);
      } catch (err2) {
        throw toModelError(err2);
      }
    }

    let content = '';
    const calls = new Map<number, ToolCall>();
    const usage = emptyUsage();
    try {
      for await (const chunk of stream) {
        if (chunk.usage) {
          const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
          usage.input = chunk.usage.prompt_tokens - cached;
          usage.cached = cached;
          usage.output = chunk.usage.completion_tokens;
        }
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          content += delta.content;
          onText(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const call = calls.get(tc.index) ?? { id: '', name: '', arguments: '' };
          if (tc.id) call.id = tc.id;
          if (tc.function?.name) call.name += tc.function.name;
          if (tc.function?.arguments) call.arguments += tc.function.arguments;
          calls.set(tc.index, call);
        }
      }
    } catch (err) {
      throw toModelError(err);
    }
    return {
      content,
      toolCalls: [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, c]) => c),
      usage,
      model: choice.name,
    };
  }
}

/** The provider refused the model or its settings (not a transient failure). */
function isModelRejection(err: unknown): boolean {
  return err instanceof OpenAI.APIError && [400, 403, 404].includes(err.status ?? 0);
}

function toModelError(err: unknown): Error {
  if ((err as Error)?.name === 'AbortError') return err as Error;
  if (err instanceof OpenAI.APIError) {
    console.error(`[sms-agent] model error ${err.status}: ${err.message}`);
    if (err.status === 429) {
      return new ModelError('The assistant is busy right now. Try again in a minute.');
    }
    return new ModelError('The assistant could not answer right now. Try again shortly.');
  }
  console.error('[sms-agent] model error', err);
  return new ModelError('The assistant could not answer right now. Try again shortly.');
}
