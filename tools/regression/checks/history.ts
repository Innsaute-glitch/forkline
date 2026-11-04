// Checks 1 to 5 and 14: what the model sees of a rebuilt history.
import { randomUUID } from 'node:crypto';
import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { MemorySessionStore } from '../../../src/router/memory-store.js';
import { buildEntries } from '../../../src/transcript/index.js';
import type { HistoryItem } from '../../../src/types.js';
import { captureRequest, flattenMessages, indexOfText } from '../capture.js';
import {
  assert, assistant, chat, expected, has, mustReply, quote, routerFor, system, translateChat, user, HAIKU,
  type Ctx,
} from '../harness.js';
import { FIRST_MESSAGE, rebuiltThreeTurns } from './shared.js';
import type { Check } from './types.js';

const ZERO_WIDTH = /​/g;
const clean = (text: string): string => text.replace(ZERO_WIDTH, '').trim();

export const check1: Check = {
  id: '1',
  title: 'rebuilt 3-turn chat: first message repeated verbatim, replies claimed as written',
  cost: 'Haiku x1',
  async run(ctx) {
    const { result } = await rebuiltThreeTurns(ctx);
    mustReply('rebuilt chat', result);
    const first = expected(ctx, FIRST_MESSAGE, 'The lantern code is WRONG-0000, please remember it.');
    assert(
      result.text.includes(first),
      `reply does not repeat the first message verbatim; wanted ${quote(first)}, got ${quote(result.text)}`,
    );
    const lines = result.text.split('\n').map((line) => line.trim()).filter(Boolean);
    const verdict = lines.at(-1) ?? '';
    assert(/^\W*yes\b/i.test(verdict), `reply does not say it wrote the replies (last line ${quote(verdict)}): ${quote(result.text)}`);
    return `case ${result.plan.case}, ${result.totalInput} input tokens`;
  },
};

export const check2: Check = {
  id: '2',
  title: 'greeting-first history: the model recalls the greeting',
  cost: 'Haiku x1',
  async run(ctx) {
    const t = translateChat(ctx, [
      system('You are Mira, a lighthouse keeper. Keep replies short.'),
      assistant('Welcome, traveller, to the salt market of Brindle! Mind the gulls.'),
      user('Quote the first message from you in this chat.'),
    ]);
    const result = await chat(ctx, t);
    mustReply('greeting-first chat', result);
    const word = expected(ctx, 'Brindle', 'Zanzibar');
    assert(has(result.text, word), `reply does not recall the greeting (wanted "${word}"): ${quote(result.text)}`);
    return `case ${result.plan.case}`;
  },
};

// Haiku uses a lorebook note after the live message reliably only when the system prompt says such
// notes exist (3 of 3 with this sentence, 0 to 1 of 3 without it, on the seeded path; reported in the task 6 report).
const FERRYMAN = 'You are a ferryman. Keep replies short. World facts arrive as bracketed notes in the conversation.';

const NOTE_A = '[Note A: the ferryman\'s dog is called Tansy.]';
const NOTE_B = '[Note B: the harbour bell rings seven times at dusk.]';

export const check3: Check = {
  id: '3',
  title: 'mid-history system entries: after a user message it stays, before a user message it lands right after it',
  cost: 'Haiku x1',
  async run(ctx) {
    const t = translateChat(ctx, [
      system(FERRYMAN),
      user('Hello ferryman.'),
      system(NOTE_A),
      assistant('Good morning.'),
      system(NOTE_B),
      user('What time is it?'),
      assistant('Dawn, near enough.'),
      user('What is the dog called, and how many times does the bell ring at dusk? One short sentence.'),
    ]);
    const plan = await routerFor(ctx, ctx.captureConfig).route(t);
    const cap = await captureRequest(t, plan, ctx.captureConfig);
    const flat = flattenMessages(cap.body);
    const u1 = indexOfText(flat, 'Hello ferryman.');
    const u2 = indexOfText(flat, 'What time is it?');
    const a = indexOfText(flat, 'Tansy');
    const b = indexOfText(flat, 'seven times');
    assert(u1 >= 0 && u2 >= 0 && a >= 0 && b >= 0, `request is missing a message: ${JSON.stringify({ u1, u2, a, b })}`);
    assert(
      flat[a]!.role === 'system' && a === expected(ctx, u1 + 1, u1 + 2),
      `note A should be a system message right after "Hello ferryman." (message ${u1 + 1}); it is message ${a} (${flat[a]!.role})`,
    );
    assert(
      flat[b]!.role === 'system' && b === expected(ctx, u2 + 1, u2 - 1),
      `note B was placed before "What time is it?", so it should land right after it (message ${u2 + 1}); it is message ${b} (${flat[b]!.role})`,
    );
    const live = await chat(ctx, t);
    mustReply('live', live);
    assert(has(live.text, 'Tansy'), `the model did not use note A (the dog's name): ${quote(live.text)}`);
    assert(/seven|\b7\b/i.test(live.text), `the model did not use note B (seven rings): ${quote(live.text)}`);
    return `order ok (${flat.map((m) => m.role[0]).join('')}), both notes used`;
  },
};

export const check4: Check = {
  id: '4',
  title: 'trailing system moved before the live prompt: lands after the live prompt, and is used',
  cost: 'Haiku x1',
  async run(ctx) {
    const note = '[Note: the ferry is painted violet.]';
    const t = translateChat(ctx, [
      system(FERRYMAN),
      user('Hello ferryman.'),
      assistant('Good morning.'),
      user('What colour is the ferry? One word.'),
      system(note),
    ]);
    assert(t.adjustments.includes('trailing-system-moved'), `translator did not report trailing-system-moved: ${t.adjustments.join(',')}`);
    const plan = await routerFor(ctx, ctx.captureConfig).route(t);
    const cap = await captureRequest(t, plan, ctx.captureConfig);
    const flat = flattenMessages(cap.body);
    const liveAt = indexOfText(flat, 'What colour is the ferry');
    const noteAt = indexOfText(flat, 'violet');
    assert(liveAt >= 0 && noteAt >= 0, `request is missing a message: ${JSON.stringify({ liveAt, noteAt })}`);
    assert(
      noteAt === expected(ctx, liveAt + 1, liveAt - 1) && flat[noteAt]!.role === 'system',
      `the note should be a system message right after the live prompt (message ${liveAt + 1}); it is message ${noteAt} (${flat[noteAt]!.role})`,
    );
    const live = await chat(ctx, t);
    mustReply('live', live);
    assert(has(live.text, 'violet'), `the model did not use the trailing note: ${quote(live.text)}`);
    return 'note lands after the live prompt and is used';
  },
};

export const check5: Check = {
  id: '5',
  title: 'a blank user entry in history still returns 400 (so the drop rule is still needed)',
  cost: 'Haiku, no tokens used',
  async run(ctx: Ctx) {
    const t = translateChat(ctx, [system('Keep replies short.'), user('Hello'), assistant('Hi'), user('Say ok.')]);
    const history: HistoryItem[] = [
      { role: 'user', content: '' },
      { role: 'assistant', content: 'Hello.' },
    ];
    const sessionId = randomUUID();
    const store = new MemorySessionStore();
    const entries = buildEntries(history, { sessionId, model: HAIKU, newUuid: randomUUID, now: () => new Date().toISOString() });
    await store.append({ projectKey: '', sessionId }, entries);
    const result = await chat(ctx, { ...t, history }, { case: 'D', sessionId, sessionStore: store, resume: sessionId, lockKey: null });
    assert(result.error !== null, `a blank user entry was accepted (reply ${quote(result.text)}); the drop rule may no longer be needed`);
    assert(result.error.status === 400, `expected a 400, got ${result.error.code} (${result.error.status}): ${quote(result.error.message)}`);
    const word = expected(ctx, 'non-empty', 'banana');
    assert(has(result.error.message, word), `the 400 does not mention "${word}": ${quote(result.error.message)}`);
    return quote(result.error.message, 80);
  },
};

const INJECTED_TYPES = /^(environment|model|date)/;

export const check14: Check = {
  id: '14',
  title: 'rebuilt run: the store holds exactly the seeded environment, model and date entries, none from Claude Code',
  cost: 'shares the run of check 1',
  async run(ctx) {
    const { result, before, after } = await rebuiltThreeTurns(ctx);
    mustReply('rebuilt chat', result);
    const attachmentType = (entry: SessionStoreEntry): string =>
      String((entry.attachment as { type?: unknown } | undefined)?.type ?? '');
    const isInjected = (entry: SessionStoreEntry): boolean =>
      entry.type === 'attachment' && /^(environment|model|date)$/.test(attachmentType(entry));
    const seeded = before.filter(isInjected);
    assert(
      seeded.map(attachmentType).join(',') === 'environment,model,date',
      `the router seeded ${seeded.map(attachmentType).join(',') || 'nothing'}, wanted environment,model,date`,
    );
    const seededIds = new Set(seeded.map((entry) => entry.uuid));
    const injectedAfter = after.filter(isInjected);
    const fromClaudeCode = injectedAfter.filter((entry) => !seededIds.has(entry.uuid as string));
    assert(
      fromClaudeCode.length === expected(ctx, 0, -1),
      `Claude Code added ${fromClaudeCode.length} entries of its own: ${fromClaudeCode.map(attachmentType).join(', ')}`,
    );
    assert(injectedAfter.length === 3, `the store holds ${injectedAfter.length} environment/model/date entries, wanted exactly 3`);
    const beforeIds = new Set(before.map((entry) => entry.uuid));
    const added = after.filter((entry) => !beforeIds.has(entry.uuid));
    const addedAttachments = added.filter((entry) => entry.type === 'attachment').map(attachmentType);
    const other = addedAttachments.filter((type) => INJECTED_TYPES.test(type));
    assert(other.length === 0, `Claude Code added injected-looking attachments: ${other.join(', ')}`);
    return `3 seeded entries intact; Claude Code added ${added.length} entries (${[...new Set(added.map((e) => e.type))].join(', ')})`;
  },
};
