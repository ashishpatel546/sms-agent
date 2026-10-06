import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, estimateUsage } from '../src/agent.js';
import { SmsBackend } from '../src/backend.js';
import type { Conversation } from '../src/conversations.js';
import type { ToolOutcome, ToolSource } from '../src/mcp.js';
import { billedSeconds } from '../src/voice.js';
import {
  BACKEND,
  FakeModel,
  TOOL_SPECS,
  claims,
  fakeBackend,
  testConfig,
  type BackendState,
} from './helpers.js';

let state: BackendState;

beforeEach(() => {
  state = { remaining: 400, calls: [] };
  fakeBackend(state);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const reports = () => state.calls.filter((c) => c.path === '/agent/usage/report');

function conversation(): Conversation {
  return {
    id: 'c1',
    owner: 'o',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    history: [],
    transcript: [],
    pending: [],
    busy: false,
  };
}

describe('usage reports', () => {
  it('carry the host key and one report id, and a retry reuses the id', async () => {
    state.reportFailures = 2;
    const backend = new SmsBackend(BACKEND, 'tok', 'edusphere', 5_000, 'host-secret');
    await backend.reportUsage({ kind: 'LLM', model: 'm', inputTokens: 10 });
    const sent = reports();
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((c) => (c.body as { reportId: string }).reportId)).size).toBe(1);
    expect(sent.every((c) => c.headers['X-Agent-Host-Key'] === 'host-secret')).toBe(true);
  });

  it('are not retried when the backend refuses them', async () => {
    const backend = new SmsBackend(BACKEND, 'tok', 'edusphere', 5_000, 'host-secret');
    state.tokenValid = false;
    await expect(backend.reportUsage({ kind: 'LLM', inputTokens: 1 })).rejects.toMatchObject({
      status: 401,
    });
    expect(reports()).toHaveLength(1);
  });

  it('never send the host key on other calls', async () => {
    const backend = new SmsBackend(BACKEND, 'tok', 'edusphere', 5_000, 'host-secret');
    await backend.quota();
    expect(state.calls[0]!.headers['X-Agent-Host-Key']).toBeUndefined();
  });
});

describe('stopping a reply', () => {
  it('does not bill a model call that never ran after tools were stopped', async () => {
    const controller = new AbortController();
    // The tool runs while the user presses stop.
    const tools: ToolSource = {
      catalog: async () => ({ tools: TOOL_SPECS, instructions: '' }),
      call: async (): Promise<ToolOutcome> => {
        controller.abort();
        return { text: 'ok', isError: false };
      },
      close: async () => undefined,
    };
    const model = new FakeModel([{ toolCalls: [{ name: 'daily_briefing', args: {} }] }]);
    const agent = new Agent(testConfig(), model);
    await agent.runTurn({
      conv: conversation(),
      claims: claims(),
      message: 'briefing',
      mode: 'text',
      tools,
      backend: new SmsBackend(BACKEND, 'tok', 'edusphere'),
      emit: () => undefined,
      signal: controller.signal,
    });
    expect(model.requests).toHaveLength(1);
    // Only the round that really ran: FakeModel reports 1200 in, 3000 cached, 150 out.
    expect(reports()).toHaveLength(1);
    expect(reports()[0]!.body).toMatchObject({
      inputTokens: 1200,
      cachedInputTokens: 3000,
      outputTokens: 150,
    });
  });

  it('bills a cut-off round with the cached share seen earlier', () => {
    const messages = [{ role: 'user' as const, content: 'x'.repeat(3_992) }];
    const full = estimateUsage(messages, [], 0);
    const split = estimateUsage(messages, [], 0, 0.75);
    expect(full.cached).toBe(0);
    expect(split.input + split.cached).toBe(full.input);
    expect(split.cached).toBe(Math.floor(full.input * 0.75));
  });
});

describe('voice input length', () => {
  it("uses the provider's duration when it gives one", () => {
    expect(billedSeconds({ type: 'duration', seconds: 12.34 }, 3)).toBe(12.3);
  });

  it('never bills less than the audio tokens show was sent', () => {
    // Declared as 1 s, but 3,000 audio tokens is at least 180 s of speech.
    expect(
      billedSeconds({ type: 'tokens', input_tokens: 3_050, input_token_details: { audio_tokens: 3_000 } }, 1),
    ).toBe(180);
  });

  it('keeps an honest declared length', () => {
    // 5 s declared; 60 audio tokens is only 3.6 s at the floor rate.
    expect(billedSeconds({ type: 'tokens', input_token_details: { audio_tokens: 60 } }, 5)).toBe(5);
  });

  it('does not round a short clip up to a whole second', () => {
    expect(billedSeconds(undefined, 0.42)).toBe(0.4);
  });
});
