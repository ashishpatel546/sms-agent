import { BackendError, type ActionRequest, type SmsBackend } from './backend.js';
import type { AgentClaims } from './claims.js';
import type { Config } from './config.js';
import {
  historyForModel,
  trimHistory,
  type Conversation,
  type TranscriptEntry,
} from './conversations.js';
import { plainAnswer } from './intent.js';
import {
  addUsage,
  emptyUsage,
  ModelError,
  type ChatModel,
  type Message,
  type ModelChoice,
  type ModelTool,
  type TokenUsage,
} from './llm.js';
import {
  ToolServerError,
  type DraftInfo,
  type ToolOutcome,
  type ToolSource,
  type ToolSpec,
} from './mcp.js';
import { BASE_PROMPT, contextMessage, type ReplyMode } from './prompt.js';

/** Streamed to the app as server-sent events, in this order. */
export type AgentEvent =
  | { type: 'start'; conversationId: string }
  | { type: 'status'; tool: string; label: string }
  | { type: 'token'; text: string }
  | { type: 'draft'; drafts: DraftInfo[] }
  | { type: 'action'; ok: boolean; text: string; actionIds: string[]; outcome: ActionOutcome }
  | {
      type: 'usage';
      credits: number;
      remaining: number;
      limit: number;
      /** Model tokens this turn: uncached input, cached input, output. */
      tokens: TokenUsage;
    }
  | { type: 'done'; text: string }
  | { type: 'error'; code: ErrorCode; message: string };

export type ErrorCode =
  | 'SESSION_EXPIRED'
  | 'SESSION_ENDED'
  | 'CREDITS_EXHAUSTED'
  | 'FORBIDDEN'
  | 'MODEL_UNAVAILABLE'
  | 'TOOLS_UNAVAILABLE'
  | 'INTERNAL';

export type ActionOutcome = 'done' | 'cancelled' | 'failed' | 'partial';

export interface ActionResult {
  ok: boolean;
  outcome: ActionOutcome;
  text: string;
  actionIds: string[];
}

/**
 * The model never sees confirm_action or cancel_action: approving (or
 * discarding) a change is the user's
 * act — a Confirm button, or a plain "yes" recognised by intent.ts — and this
 * service carries it out. A model misled by text inside the data therefore
 * cannot approve anything.
 */
const HOST_ONLY_TOOLS = new Set(['confirm_action', 'cancel_action']);

/** Entries of the visible exchange kept for the app to reload. */
const MAX_TRANSCRIPT = 200;

export class AgentFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function toFailure(err: unknown): AgentFailure {
  if (err instanceof AgentFailure) return err;
  if (err instanceof ToolServerError || err instanceof BackendError) {
    if (err.status === 401 && err instanceof BackendError && err.code === 'AGENT_SESSION_ENDED') {
      return new AgentFailure(
        'SESSION_ENDED',
        'This conversation has ended. Your next message starts a new one.',
      );
    }
    if (err.status === 401) {
      return new AgentFailure('SESSION_EXPIRED', 'The assistant session has expired.');
    }
    if (err.status === 402) {
      return new AgentFailure(
        'CREDITS_EXHAUSTED',
        err.message ||
          "This school's AI Assistant credits for the month are used up. An administrator can add more.",
      );
    }
    if (err.status === 403) return new AgentFailure('FORBIDDEN', err.message);
    return new AgentFailure('TOOLS_UNAVAILABLE', err.message);
  }
  if (err instanceof ModelError) {
    return new AgentFailure('MODEL_UNAVAILABLE', err.message);
  }
  console.error('[sms-agent] turn failed', err);
  return new AgentFailure('INTERNAL', 'Something went wrong. Try again in a moment.');
}

/** MCP input schema → OpenAI function parameters. */
export function toModelTools(tools: ToolSpec[]): ModelTool[] {
  return tools
    .filter((t) => !HOST_ONLY_TOOLS.has(t.name))
    .map((t) => {
      const { $schema: _ignored, ...parameters } = t.inputSchema;
      return {
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters },
      };
    });
}

function statusLabel(tool: ToolSpec | undefined, name: string): string {
  const title = tool?.title ?? name.replace(/_/g, ' ');
  return name.startsWith('draft_') ? `Preparing: ${title}` : `Checking: ${title}`;
}

/** Rough token count (≈4 characters per token) for a round that never reported usage. */
function estimateUsage(messages: Message[], tools: ModelTool[], outputChars: number): TokenUsage {
  const promptChars = JSON.stringify(messages).length + JSON.stringify(tools).length;
  return { input: Math.ceil(promptChars / 4), cached: 0, output: Math.ceil(outputChars / 4) };
}

/**
 * After an interrupted turn, give any tool call left without a result a
 * placeholder one: the provider rejects a history with an unanswered call,
 * which would break every later message in the conversation.
 */
export function sealHistory(history: Message[]) {
  const answered = new Set(
    history.filter((m) => m.role === 'tool').map((m) => (m as { tool_call_id: string }).tool_call_id),
  );
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role === 'user') break;
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    const missing = m.tool_calls.filter((c) => !answered.has(c.id));
    history.splice(
      i + 1 + m.tool_calls.length - missing.length,
      0,
      ...missing.map((c) => ({
        role: 'tool' as const,
        tool_call_id: c.id,
        content: 'ERROR: interrupted before this ran.',
      })),
    );
  }
}

function isLive(d: DraftInfo, now = Date.now()) {
  return !d.expires_at || Date.parse(d.expires_at) > now;
}

export interface TurnInput {
  conv: Conversation;
  claims: AgentClaims;
  message: string;
  mode: ReplyMode;
  tools: ToolSource;
  backend: SmsBackend;
  emit: (e: AgentEvent) => void;
  signal?: AbortSignal;
}

export class Agent {
  constructor(
    private readonly config: Config,
    private readonly model: ChatModel,
  ) {}

  /** One user message → streamed reply, tool calls and drafts. */
  async runTurn(input: TurnInput): Promise<void> {
    const { conv, message, emit } = input;
    conv.transcript.push({ role: 'user', text: message, at: new Date().toISOString() });

    if (await this.answerPendingDraft(input)) return;

    let usage = emptyUsage();
    let usedModel = this.model.name;
    let historyTurns = this.config.historyMaxTurns;
    const entry: TranscriptEntry = { role: 'assistant', text: '', at: '' };
    try {
      const quota = await input.backend.quota();
      if (quota.remaining <= 0) {
        throw new AgentFailure(
          'CREDITS_EXHAUSTED',
          `This school has used all ${quota.limit} AI Assistant credits for ${quota.month}. An administrator can add more.`,
        );
      }
      // The hub's model choice, when it made one; otherwise AGENT_MODEL.
      const model: ModelChoice | undefined = quota.model
        ? { name: quota.model, reasoningEffort: quota.reasoningEffort }
        : undefined;
      usedModel = model?.name ?? usedModel;
      historyTurns = quota.historyMaxTurns ?? historyTurns;
      const { tools, instructions } = await input.tools.catalog();
      const byName = new Map(tools.map((t) => [t.name, t]));
      const modelTools = toModelTools(tools);
      const allowed = new Set(modelTools.map((t) => t.function.name));

      conv.history.push({ role: 'user', content: message });
      const messages: Message[] = [
        { role: 'system', content: BASE_PROMPT },
        {
          role: 'system',
          content: contextMessage(input.claims, input.mode, instructions),
        },
        ...historyForModel(
          conv.history,
          this.config.historyBudgetChars,
          // The current message is a turn too.
          (quota.historyMaxTurns ?? this.config.historyMaxTurns) + 1,
        ),
      ];

      const drafts: DraftInfo[] = [];
      let text = '';
      let finished = false;
      for (let round = 0; round < this.config.maxToolRounds; round++) {
        if (text && !text.endsWith('\n')) {
          text += '\n\n';
          emit({ type: 'token', text: '\n\n' });
        }
        let streamed = 0;
        let reply;
        try {
          reply = await this.model.complete(
            {
              messages,
              tools: modelTools,
              cacheKey: `sms-agent:${input.claims.schoolId}:${input.claims.role}`,
              model,
              signal: input.signal,
            },
            (delta) => {
              streamed += delta.length;
              text += delta;
              emit({ type: 'token', text: delta });
            },
          );
        } catch (err) {
          // A round cut off mid-stream is still billed by the provider, but
          // its usage figures never arrive: charge an estimate instead.
          if (input.signal?.aborted || streamed > 0) {
            usage = addUsage(usage, estimateUsage(messages, modelTools, streamed));
          }
          throw err;
        }
        usage = addUsage(usage, reply.usage);
        usedModel = reply.model ?? usedModel;

        const assistant: Message = reply.toolCalls.length
          ? {
              role: 'assistant',
              content: reply.content || null,
              tool_calls: reply.toolCalls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          : { role: 'assistant', content: reply.content };
        messages.push(assistant);
        conv.history.push(assistant);
        if (!reply.toolCalls.length) {
          finished = true;
          break;
        }

        for (const call of reply.toolCalls) {
          emit({ type: 'status', tool: call.name, label: statusLabel(byName.get(call.name), call.name) });
        }
        let fatal: unknown = null;
        const results = await Promise.all(
          reply.toolCalls.map(async (call): Promise<ToolOutcome> => {
            if (!allowed.has(call.name)) {
              return { text: `Unknown tool ${call.name}.`, isError: true };
            }
            let args: Record<string, unknown>;
            try {
              args = call.arguments ? JSON.parse(call.arguments) : {};
            } catch {
              return { text: 'Invalid tool arguments (not JSON).', isError: true };
            }
            try {
              return await input.tools.call(call.name, args);
            } catch (err) {
              fatal ??= err;
              return { text: 'Not run: the session ended.', isError: true };
            }
          }),
        );
        reply.toolCalls.forEach((call, i) => {
          const r = results[i]!;
          if ('draft' in r && r.draft) drafts.push(r.draft);
          const content = r.text.slice(0, this.config.toolResultMaxChars);
          const toolMsg: Message = {
            role: 'tool',
            tool_call_id: call.id,
            content: r.isError ? `ERROR: ${content}` : content,
          };
          messages.push(toolMsg);
          conv.history.push(toolMsg);
        });
        // Every tool call now has its result, so the history stays valid.
        if (fatal) throw fatal;
      }

      if (!finished) {
        const note =
          "I couldn't finish that in one go. Please try a simpler or more specific request.";
        text += text ? `\n\n${note}` : note;
        emit({ type: 'token', text: note });
        conv.history.push({ role: 'assistant', content: note });
      }

      if (drafts.length) {
        await this.replacePending(conv, drafts, input.backend);
        emit({ type: 'draft', drafts });
        entry.drafts = drafts.map((d) => ({ ...d, state: 'pending' }));
      }
      entry.text = text.trim();
      emit({ type: 'done', text: entry.text });
    } catch (err) {
      if (input.signal?.aborted) {
        entry.text = '(Stopped.)';
        return;
      }
      const f = toFailure(err);
      emit({ type: 'error', code: f.code, message: f.message });
      entry.text = f.message;
    } finally {
      sealHistory(conv.history);
      trimHistory(conv.history, historyTurns + 1);
      entry.at = new Date().toISOString();
      if (entry.text) conv.transcript.push(entry);
      if (conv.transcript.length > MAX_TRANSCRIPT) {
        conv.transcript.splice(0, conv.transcript.length - MAX_TRANSCRIPT);
      }
      await this.reportUsage(input, usage, usedModel);
    }
  }

  /** Charges the school for the model tokens this turn used. */
  private async reportUsage(input: TurnInput, usage: TokenUsage, model: string) {
    if (!usage.input && !usage.cached && !usage.output) return;
    try {
      const r = await input.backend.reportUsage({
        kind: 'LLM',
        model,
        inputTokens: usage.input,
        cachedInputTokens: usage.cached,
        outputTokens: usage.output,
      });
      input.emit({
        type: 'usage',
        credits: r.credits,
        remaining: r.quota.remaining,
        limit: r.quota.limit,
        tokens: usage,
      });
    } catch (err) {
      console.error('[sms-agent] usage report failed', (err as Error).message);
    }
  }

  /** New drafts replace the previous reply's: the user can't confirm stale ones. */
  private async replacePending(conv: Conversation, drafts: DraftInfo[], backend: SmsBackend) {
    const keep = new Set(drafts.flatMap((d) => d.action_ids));
    const stale = conv.pending.flatMap((d) => d.action_ids).filter((id) => !keep.has(id));
    await Promise.all(stale.map((id) => backend.cancelAction(id).catch(() => undefined)));
    this.markDrafts(conv, stale, 'cancelled');
    conv.pending = drafts;
  }

  /**
   * A plain yes/no while drafts are pending is answered here, without the
   * model. Returns false when the message is anything else.
   */
  private async answerPendingDraft(input: TurnInput): Promise<boolean> {
    const { conv, emit } = input;
    if (!conv.pending.length) return false;
    const answer = plainAnswer(input.message);
    if (!answer) return false;

    const live = conv.pending.filter((d) => isLive(d));
    const ids = live.flatMap((d) => d.action_ids);
    let result: ActionResult;
    if (!ids.length) {
      this.markDrafts(conv, conv.pending.flatMap((d) => d.action_ids), 'cancelled');
      conv.pending = [];
      result = {
        ok: false,
        outcome: 'failed',
        text: 'That draft has expired, so nothing was changed. Ask me again to prepare it afresh.',
        actionIds: [],
      };
    } else if (answer === 'no') {
      result = await this.cancel(conv, ids, input.backend, false);
    } else if (this.config.confirmMode === 'user') {
      result = {
        ok: false,
        outcome: 'failed',
        text: 'Please press Confirm on the draft to approve this change.',
        actionIds: [],
      };
    } else {
      try {
        result = await this.confirm(conv, ids, input.backend, false);
      } catch (err) {
        const f = toFailure(err);
        emit({ type: 'error', code: f.code, message: f.message });
        return true;
      }
    }
    conv.history.push({ role: 'user', content: input.message });
    conv.history.push({ role: 'assistant', content: result.text });
    conv.transcript.push({ role: 'assistant', text: result.text, at: new Date().toISOString() });
    if (result.actionIds.length) emit({ type: 'action', ...result });
    emit({ type: 'token', text: result.text });
    emit({ type: 'done', text: result.text });
    return true;
  }

  private pendingIds(conv: Conversation, ids: string[]): string[] {
    const pending = new Set(conv.pending.flatMap((d) => d.action_ids));
    const unknown = ids.filter((id) => !pending.has(id));
    if (unknown.length) {
      throw new AgentFailure(
        'FORBIDDEN',
        'That draft is no longer waiting for confirmation in this conversation.',
      );
    }
    return ids;
  }

  /** Confirm button (agent mode) or a plain yes: confirm, then run. */
  async confirm(
    conv: Conversation,
    ids: string[],
    backend: SmsBackend,
    fromButton = true,
  ): Promise<ActionResult> {
    this.pendingIds(conv, ids);
    return this.run(conv, ids, backend, (id) => backend.confirmAction(id), fromButton, 'Confirm.');
  }

  /**
   * User confirm mode: the app has already confirmed each action with the
   * user's own session token and passes the request sms-backend returned.
   * sms-backend still checks it byte-for-byte against what was confirmed.
   */
  async execute(
    conv: Conversation,
    actions: { id: string; request: ActionRequest }[],
    backend: SmsBackend,
  ): Promise<ActionResult> {
    const ids = actions.map((a) => a.id);
    this.pendingIds(conv, ids);
    const byId = new Map(actions.map((a) => [a.id, a.request]));
    return this.run(
      conv,
      ids,
      backend,
      async (id) => ({ id, summary: '', status: 'CONFIRMED', request: byId.get(id)! }),
      true,
      'Confirm.',
    );
  }

  private async run(
    conv: Conversation,
    ids: string[],
    backend: SmsBackend,
    prepare: (id: string) => Promise<{ summary: string; request: ActionRequest }>,
    fromButton: boolean,
    userSaid: string,
  ): Promise<ActionResult> {
    const summaries = new Map(
      conv.pending.flatMap((d) => d.action_ids.map((id) => [id, d.summary] as const)),
    );
    const done: string[] = [];
    const failed: string[] = [];
    const doneIds: string[] = [];
    const failedIds: string[] = [];
    for (const id of ids) {
      try {
        const exec = await prepare(id);
        await backend.execute(id, exec.request);
        done.push(exec.summary || summaries.get(id) || 'Change saved.');
        doneIds.push(id);
      } catch (err) {
        if (err instanceof BackendError && (err.status === 401 || err.status === 402)) {
          // Keep what already ran marked as done before giving up.
          this.markDrafts(conv, doneIds, 'done');
          this.dropPending(conv, doneIds);
          throw err;
        }
        failed.push(err instanceof BackendError ? err.message : 'It could not be saved.');
        failedIds.push(id);
      }
    }
    this.markDrafts(conv, doneIds, 'done');
    this.markDrafts(conv, failedIds, 'failed');
    this.dropPending(conv, ids);

    const uniq = (xs: string[]) => [...new Set(xs)].join(' ');
    const doneText = uniq(done).replace(/Parents will be notified\./g, 'Parents have been notified.');
    const outcome: ActionOutcome = failed.length ? (done.length ? 'partial' : 'failed') : 'done';
    const text =
      outcome === 'done'
        ? `Done. ${doneText}`
        : outcome === 'partial'
          ? `Done: ${doneText} Not done: ${uniq(failed)}`
          : `Not done: ${uniq(failed)}`;
    if (fromButton) this.recordButton(conv, userSaid, text);
    return { ok: outcome !== 'failed', outcome, text, actionIds: ids };
  }

  async cancel(
    conv: Conversation,
    ids: string[],
    backend: SmsBackend,
    fromButton = true,
  ): Promise<ActionResult> {
    this.pendingIds(conv, ids);
    await Promise.all(ids.map((id) => backend.cancelAction(id).catch(() => undefined)));
    this.markDrafts(conv, ids, 'cancelled');
    this.dropPending(conv, ids);
    const text = 'Cancelled. Nothing was changed.';
    if (fromButton) this.recordButton(conv, 'Cancel.', text);
    return { ok: true, outcome: 'cancelled', text, actionIds: ids };
  }

  /** So the model knows what happened when the conversation continues. */
  private recordButton(conv: Conversation, userSaid: string, text: string) {
    conv.history.push({ role: 'user', content: `(Pressed "${userSaid.replace('.', '')}" on the draft.)` });
    conv.history.push({ role: 'assistant', content: text });
    conv.transcript.push({ role: 'assistant', text, at: new Date().toISOString() });
  }

  private dropPending(conv: Conversation, ids: string[]) {
    const gone = new Set(ids);
    conv.pending = conv.pending
      .map((d) => ({ ...d, action_ids: d.action_ids.filter((id) => !gone.has(id)) }))
      .filter((d) => d.action_ids.length);
  }

  private markDrafts(
    conv: Conversation,
    ids: string[],
    state: 'done' | 'cancelled' | 'failed',
  ) {
    if (!ids.length) return;
    const set = new Set(ids);
    for (const e of conv.transcript) {
      for (const d of e.drafts ?? []) {
        if (d.state === 'pending' && d.action_ids.some((id) => set.has(id))) {
          d.state = state;
        }
      }
    }
  }
}
