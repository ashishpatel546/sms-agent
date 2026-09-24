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
}

export interface ModelRequest {
  messages: Message[];
  tools: ModelTool[];
  /** Routes requests with the same prefix to the same prompt cache. */
  cacheKey: string;
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
    let stream;
    try {
      stream = await this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: req.messages,
          tools: req.tools.length ? req.tools : undefined,
          parallel_tool_calls: req.tools.length ? true : undefined,
          reasoning_effort: this.config.reasoningEffort,
          max_completion_tokens: this.config.maxOutputTokens,
          prompt_cache_key: req.cacheKey,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: req.signal },
      );
    } catch (err) {
      throw toModelError(err);
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
    };
  }
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
