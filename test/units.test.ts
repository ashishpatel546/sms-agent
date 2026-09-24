import { describe, expect, it } from 'vitest';
import { sealHistory, toModelTools } from '../src/agent.js';
import { historyForModel } from '../src/conversations.js';
import { speakable } from '../src/http.js';
import { plainAnswer } from '../src/intent.js';
import type { Message } from '../src/llm.js';
import { contextMessage } from '../src/prompt.js';
import { RateLimiter } from '../src/ratelimit.js';
import { claims, TOOL_SPECS } from './helpers.js';

describe('plainAnswer', () => {
  it.each([
    'yes', 'Yes.', 'YES!', 'ok', 'okay go ahead', 'confirm', 'yes please', 'go ahead',
    'haan', 'haan ji', 'theek hai', 'kar do', 'हाँ', 'ठीक है', 'yes sir', 'ji',
  ])('%s → yes', (t) => expect(plainAnswer(t)).toBe('yes'));

  it.each(['no', 'No.', 'cancel', "don't", 'nahi', 'nahi ji', 'mat karo', 'नहीं', 'rehne do'])(
    '%s → no',
    (t) => expect(plainAnswer(t)).toBe('no'),
  );

  it.each([
    'yes but mark Riya late',
    'no, Aman was present',
    'what about 7A?',
    'mark 6B attendance',
    'yes yes yes yes yes yes',
    '',
  ])('%s → neither', (t) => expect(plainAnswer(t)).toBeNull());
});

describe('historyForModel', () => {
  const turn = (i: number, toolText = 'x'.repeat(500)): Message[] => [
    { role: 'user', content: `question ${i}` },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 't', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: `c${i}`, content: toolText },
    { role: 'assistant', content: `answer ${i}` },
  ];

  it('keeps whole turns, newest first, within the budget', () => {
    const h = [...turn(1), ...turn(2), ...turn(3), ...turn(4)];
    const out = historyForModel(h, 1500);
    expect(out[0]).toMatchObject({ role: 'user' });
    expect(out.at(-1)).toMatchObject({ content: 'answer 4' });
    // A tool result is never separated from its call.
    const ids = out.filter((m) => m.role === 'tool').map((m) => (m as { tool_call_id: string }).tool_call_id);
    for (const id of ids) {
      expect(out.some((m) => m.role === 'assistant' && m.tool_calls?.some((c) => c.id === id))).toBe(true);
    }
    expect(out.length).toBeLessThan(h.length);
  });

  it('shortens tool results older than the last two turns', () => {
    const h = [...turn(1), ...turn(2), ...turn(3)];
    const out = historyForModel(h, 100_000);
    const tools = out.filter((m) => m.role === 'tool').map((m) => String(m.content));
    expect(tools[0]!.length).toBeLessThan(300);
    expect(tools[2]!.length).toBe(500);
  });

  it('always keeps the latest turn even if it alone is over budget', () => {
    const out = historyForModel(turn(1, 'y'.repeat(5000)), 100);
    expect(out).toHaveLength(4);
  });
});

describe('toModelTools', () => {
  it('hides confirm_action and cancel_action from the model and strips $schema', () => {
    const tools = toModelTools(TOOL_SPECS);
    const names = tools.map((t) => t.function.name);
    expect(names).not.toContain('confirm_action');
    expect(names).not.toContain('cancel_action');
    expect(names).toContain('draft_attendance');
    expect(tools[0]!.function.parameters).not.toHaveProperty('$schema');
  });
});

describe('sealHistory', () => {
  it('answers tool calls left without a result, in place', () => {
    const h: Message[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 't', arguments: '{}' } },
          { id: 'b', type: 'function', function: { name: 't', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'a', content: 'ok' },
    ];
    sealHistory(h);
    expect(h.map((m) => (m.role === 'tool' ? m.tool_call_id : m.role))).toEqual(['user', 'assistant', 'a', 'b']);
    sealHistory(h);
    expect(h).toHaveLength(4);
  });
});

describe('speakable', () => {
  it('drops markdown and tables and cuts at a sentence', () => {
    const t = speakable(
      '**12 of 14** registers taken.\n| class | taker |\n|---|---|\n| 6B | Asha |\n- 6B pending\nMore details follow here. And more text that goes on.',
      60,
    );
    expect(t).not.toMatch(/[*|#]/);
    expect(t.startsWith('12 of 14 registers taken.')).toBe(true);
    expect(t.length).toBeLessThanOrEqual(61);
  });
});

describe('contextMessage', () => {
  it('names the user and switches style for voice and read-only sessions', () => {
    const m = contextMessage(claims({ agentScopes: ['read'] }), 'voice', 'Tools for X.', new Date('2026-09-24T03:00:00Z'));
    expect(m).toContain('Asha Verma (TEACHER)');
    expect(m).toContain('Thursday');
    expect(m).toContain('read-only');
    expect(m).toContain('Voice mode');
    expect(m).toContain('Tools for X.');
  });
});

describe('RateLimiter', () => {
  it('counts per key within a window', () => {
    const r = new RateLimiter(2, 1000);
    expect(r.take('a', 0)).toBe(0);
    expect(r.take('a', 1)).toBe(0);
    expect(r.take('a', 2)).toBeGreaterThan(0);
    expect(r.take('b', 2)).toBe(0);
    expect(r.take('a', 1001)).toBe(0);
  });
});
