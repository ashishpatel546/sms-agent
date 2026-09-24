import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { vi } from 'vitest';
import type { AgentClaims } from '../src/claims.js';
import { loadConfig, type Config } from '../src/config.js';
import { createApp, type AppDeps } from '../src/http.js';
import type { ChatModel, ModelRequest, ModelTurn, ToolCall } from '../src/llm.js';
import type { DraftInfo, ToolOutcome, ToolSource, ToolSpec } from '../src/mcp.js';

export const BACKEND = 'http://backend.test';
export const ACTION_A = '11111111-1111-4111-8111-111111111111';
export const ACTION_B = '22222222-2222-4222-8222-222222222222';

export function claims(over: Partial<AgentClaims> = {}): AgentClaims {
  return {
    sub: 7,
    role: 'TEACHER',
    roles: ['TEACHER'],
    firstName: 'Asha',
    lastName: 'Verma',
    schoolId: 3,
    slug: 'edusphere',
    agent: true,
    agentSessionId: 'sess-1',
    agentScopes: ['read', 'write'],
    exp: Math.floor(Date.now() / 1000) + 1800,
    ...over,
  };
}

/** Unsigned JWT — this service only decodes; the backend verifies. */
export function token(c: Partial<AgentClaims> | Record<string, unknown> = claims()): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(c)}.sig`;
}

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    ...loadConfig({ SMS_API_URL: BACKEND, OPENAI_API_KEY: 'test', AGENT_STT_MODEL: '', AGENT_TTS_MODEL: '' }),
    ...over,
  };
}

// ── Model ───────────────────────────────────────────────────────────────────

export interface ScriptedTurn {
  content?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
}

export class FakeModel implements ChatModel {
  readonly name = 'fake-model';
  readonly requests: ModelRequest[] = [];
  private n = 0;

  constructor(private readonly script: ScriptedTurn[]) {}

  async complete(req: ModelRequest, onText: (d: string) => void): Promise<ModelTurn> {
    this.requests.push(structuredClone({ ...req, signal: undefined }));
    const turn = this.script.shift() ?? { content: 'OK.' };
    if (turn.content) {
      for (const part of turn.content.match(/.{1,6}/gs) ?? []) onText(part);
    }
    const toolCalls: ToolCall[] = (turn.toolCalls ?? []).map((c) => ({
      id: `call_${++this.n}`,
      name: c.name,
      arguments: JSON.stringify(c.args),
    }));
    return {
      content: turn.content ?? '',
      toolCalls,
      usage: { input: 1200, cached: 3000, output: 150 },
    };
  }
}

// ── Tools ───────────────────────────────────────────────────────────────────

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'daily_briefing',
    title: "Today's briefing",
    description: 'What is happening today.',
    inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: {} },
  },
  {
    name: 'draft_attendance',
    title: 'Draft class attendance',
    description: 'Prepare attendance.',
    inputSchema: { type: 'object', properties: { class: { type: 'string' } } },
  },
  {
    name: 'confirm_action',
    title: 'Confirm',
    description: 'Carries out drafted changes.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_action',
    title: 'Cancel',
    description: 'Discards drafts.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export function draftOf(id: string, summary = 'Mark attendance for Class 6-B on Thu 24 Sep: 2 of 3 present; absent: Aman Gupta.'): DraftInfo {
  return {
    action_ids: [id],
    summary,
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

export class FakeTools implements ToolSource {
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  private drafts: string[];

  constructor(drafts: string[] = [ACTION_A, ACTION_B]) {
    this.drafts = [...drafts];
  }

  async catalog() {
    return { tools: TOOL_SPECS, instructions: 'Tools for staff of Edusphere.' };
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    this.calls.push({ name, args });
    if (name === 'daily_briefing') {
      return { text: 'Thu 24 Sep: 12 of 14 registers taken.\npending: 6B, 7A', isError: false };
    }
    if (name === 'draft_attendance') {
      const id = this.drafts.shift()!;
      const d = draftOf(id);
      return { text: `DRAFT, not saved: ${d.summary}`, isError: false, draft: d };
    }
    return { text: 'ok', isError: false };
  }

  async close() {}
}

// ── Backend ─────────────────────────────────────────────────────────────────

export interface BackendCall {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface BackendState {
  remaining: number;
  calls: BackendCall[];
  /** false: sms-backend rejects the token (forged or revoked). */
  tokenValid?: boolean;
  /** Status the write route answers with (default 201). */
  writeStatus?: number;
}

/** Routes fetch() to a fake sms-backend. */
export function fakeBackend(state: BackendState) {
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== BACKEND) return real(input, init);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    state.calls.push({ method, path: url.pathname, body, headers });
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    const quota = { month: '2026-09', limit: 500, used: 500 - state.remaining, remaining: state.remaining };
    if (state.tokenValid === false) return json({ message: 'Unauthorized' }, 401);

    if (url.pathname === '/agent/quota') return json(quota);
    if (url.pathname === '/agent/usage/report') return json({ credits: 3, quota });
    const m = url.pathname.match(/^\/agent\/actions\/([0-9a-f-]+)\/(confirm|cancel)$/);
    if (m) {
      if (m[2] === 'cancel') return json({ id: m[1], status: 'CANCELLED' });
      return json({
        id: m[1],
        summary: 'Mark attendance for Class 6-B on Thu 24 Sep: 2 of 3 present; absent: Aman Gupta.',
        status: 'CONFIRMED',
        request: { method: 'POST', path: '/attendance', body: { date: '2026-09-24', classId: 9 } },
      });
    }
    if (url.pathname === '/attendance' && method === 'POST') {
      return (state.writeStatus ?? 201) < 300
        ? json({ id: 5 }, 201)
        : json({ message: 'Attendance for this class is already marked.' }, state.writeStatus);
    }
    return json({ message: 'not found' }, 404);
  });
}

// ── HTTP ────────────────────────────────────────────────────────────────────

export async function startApp(deps: Partial<AppDeps> & { model: ChatModel }) {
  const app = createApp({ config: testConfig(), tools: () => new FakeTools(), ...deps });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export type Event = Record<string, any> & { type: string };

export async function chat(
  base: string,
  body: Record<string, unknown>,
  tok = token(),
): Promise<{ status: number; events: Event[] }> {
  const res = await fetch(`${base}/v1/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const events = text
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)) as Event);
  return { status: res.status, events };
}

export async function post(base: string, path: string, body: unknown, tok = token()) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

export const textOf = (events: Event[]) =>
  events.filter((e) => e.type === 'token').map((e) => e.text).join('');
