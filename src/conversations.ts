import { randomUUID } from 'node:crypto';
import type { DraftInfo } from './mcp.js';
import type { Message } from './llm.js';

/** What the app shows: the visible exchange, without tool traffic. */
export interface TranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
  at: string;
  /** Drafted changes proposed in this reply, with their final state. */
  drafts?: (DraftInfo & { state: 'pending' | 'done' | 'cancelled' | 'failed' })[];
}

export interface Conversation {
  id: string;
  owner: string;
  createdAt: number;
  updatedAt: number;
  /** What the model sees (user, assistant, tool messages). */
  history: Message[];
  transcript: TranscriptEntry[];
  /** Drafts from the latest reply still waiting for a yes or no. */
  pending: DraftInfo[];
  /** Set while a turn runs: one turn at a time per conversation. */
  busy: boolean;
}

/**
 * Conversations in memory, per person, forgotten after an idle period.
 *
 * Kept in process on purpose for phase 1: nothing here is a record — school
 * data lives in sms-backend, drafts are stored there too, and a lost
 * conversation only means the user starts a new one. Several instances need
 * sticky routing by user until this moves to a shared store.
 */
export class ConversationStore {
  private readonly items = new Map<string, Conversation>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxPerOwner: number,
  ) {}

  get(owner: string, id: string | undefined): Conversation | undefined {
    if (!id) return undefined;
    const c = this.items.get(id);
    if (!c || c.owner !== owner) return undefined;
    if (Date.now() - c.updatedAt > this.ttlMs) {
      this.items.delete(id);
      return undefined;
    }
    return c;
  }

  create(owner: string): Conversation {
    this.sweep();
    const mine = [...this.items.values()]
      .filter((c) => c.owner === owner)
      .sort((a, b) => a.updatedAt - b.updatedAt);
    while (mine.length >= this.maxPerOwner) {
      const oldest = mine.shift()!;
      this.items.delete(oldest.id);
    }
    const now = Date.now();
    const c: Conversation = {
      id: randomUUID(),
      owner,
      createdAt: now,
      updatedAt: now,
      history: [],
      transcript: [],
      pending: [],
      busy: false,
    };
    this.items.set(c.id, c);
    return c;
  }

  delete(owner: string, id: string): boolean {
    const c = this.items.get(id);
    if (!c || c.owner !== owner) return false;
    return this.items.delete(id);
  }

  touch(c: Conversation) {
    c.updatedAt = Date.now();
  }

  private sweep() {
    const now = Date.now();
    for (const [id, c] of this.items) {
      if (now - c.updatedAt > this.ttlMs) this.items.delete(id);
    }
  }
}

const OLD_TOOL_RESULT_CHARS = 280;

function size(m: Message): number {
  let n = typeof m.content === 'string' ? m.content.length : 0;
  if (m.role === 'assistant' && m.tool_calls) {
    for (const tc of m.tool_calls) {
      if (tc.type === 'function') n += tc.function.arguments.length + 40;
    }
  }
  return n + 20;
}

/**
 * The history to send: whole turns only (a turn starts at a user message, so
 * a tool call is never separated from its result), newest first until the
 * character budget is spent. Tool results older than the last two turns are
 * cut to their summary line — the model rarely needs them verbatim again.
 */
export function historyForModel(history: Message[], budgetChars: number): Message[] {
  const turns: Message[][] = [];
  for (const m of history) {
    if (m.role === 'user' || turns.length === 0) turns.push([]);
    turns[turns.length - 1]!.push(m);
  }
  const kept: Message[][] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const recent = turns.length - 1 - i < 2;
    const turn = recent
      ? turns[i]!
      : turns[i]!.map((m) =>
          m.role === 'tool' &&
          typeof m.content === 'string' &&
          m.content.length > OLD_TOOL_RESULT_CHARS
            ? { ...m, content: `${m.content.slice(0, OLD_TOOL_RESULT_CHARS)}…` }
            : m,
        );
    const cost = turn.reduce((n, m) => n + size(m), 0);
    if (kept.length > 0 && used + cost > budgetChars) break;
    kept.unshift(turn);
    used += cost;
  }
  return kept.flat();
}
