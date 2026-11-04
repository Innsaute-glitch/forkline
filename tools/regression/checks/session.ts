// Checks 6, 7, 12 and the two the plan adds: caching, system prompt on resume, missing session,
// a retired model, and the <synthetic> path.
import { randomUUID } from 'node:crypto';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { MemorySessionStore } from '../../../src/router/memory-store.js';
import type { QueryFn } from '../../../src/runner/index.js';
import { run } from '../../../src/runner/index.js';
import {
  Failure, Skip, assert, assistant, chat, expected, has, mustReply, newPlan, padding, quote, resumePlan, routerFor,
  summarize, system, translateChat, user, withModel, type Ctx,
} from '../harness.js';
import type { Check } from './types.js';

/** Prompt tokens read from cache as a share of everything sent. */
const cacheShare = (usage: { cacheReadTokens: number }, total: number): number => (total === 0 ? 0 : usage.cacheReadTokens / total);
const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;

export const check6: Check = {
  id: '6',
  title: 'caching on rebuilt chats: an identical repeat is read from cache; a next turn with the lorebook moved reads most of it',
  cost: 'Haiku x3, about 5k tokens each',
  async run(ctx: Ctx) {
    // A nonce in the system prompt keeps older cache entries from hitting.
    const nonce = randomUUID().slice(0, 8);
    const sheet = `Stay concise. Reference sheet ${nonce}:\n${padding(nonce, 8_000)}`;
    const lore = system('[Lore: the harbour was founded by Ilse Marrow.]');
    const turns = [
      user('Good morning, ferryman.'),
      assistant('Good morning. The river is calm today.'),
      user('Is the lantern lit?'),
      assistant('It is, and the oil will last until noon.'),
    ];
    const turn1 = translateChat(ctx, [system(sheet), ...turns, user('Say OK.'), lore]);
    const first = await chat(ctx, turn1);
    mustReply('first request', first);
    assert(first.totalInput >= 3000, `the prompt is only ${first.totalInput} tokens; the check needs 3k or more to cache`);

    // Same request again: a new session, byte-identical prompt.
    const repeat = await chat(ctx, turn1);
    mustReply('repeat request', repeat);
    const repeatShare = cacheShare(repeat.usage!, repeat.totalInput);
    const wantRepeat = expected(ctx, 0.95, 1.01);
    assert(
      repeatShare >= wantRepeat,
      `identical repeat read ${repeat.usage!.cacheReadTokens} of ${repeat.totalInput} prompt tokens from cache (${pct(repeatShare)}), wanted at least ${pct(wantRepeat)}; ${repeat.usage!.cacheWriteTokens} written`,
    );
    assert(
      repeat.usage!.cacheWriteTokens <= Math.max(50, repeat.totalInput * 0.02),
      `identical repeat still wrote ${repeat.usage!.cacheWriteTokens} tokens to cache`,
    );

    // Next turn: the first reply joins the history and the lorebook moves to the new end.
    const turn2 = translateChat(ctx, [
      system(sheet), ...turns, user('Say OK.'), assistant(first.text), user('Say OK again.'), lore,
    ]);
    const next = await chat(ctx, turn2);
    mustReply('next turn', next);
    const nextShare = cacheShare(next.usage!, next.totalInput);
    const wantNext = expected(ctx, 0.6, 1.01);
    assert(
      nextShare >= wantNext,
      `next turn read ${next.usage!.cacheReadTokens} of ${next.totalInput} prompt tokens from cache (${pct(nextShare)}), wanted at least ${pct(wantNext)}`,
    );
    return `prompt ${first.totalInput} tokens; repeat read ${repeat.usage!.cacheReadTokens}/${repeat.totalInput} (${pct(repeatShare)}, ${repeat.usage!.cacheWriteTokens} written); next turn read ${next.usage!.cacheReadTokens}/${next.totalInput} (${pct(nextShare)})`;
  },
};

export const check7: Check = {
  id: '7',
  title: 'snapshot: false - a changed system prompt applies on resume',
  cost: 'Haiku x2',
  async run(ctx) {
    const one = translateChat(ctx, [system('x'), user('Go.')]);
    one.systemPrompt = ['Reply with exactly the single word BLUE and nothing else.'];
    const firstTurn = await chat(ctx, one);
    mustReply('first turn', firstTurn);
    assert(has(firstTurn.text, 'BLUE'), `first turn ignored the system prompt: ${quote(firstTurn.text)}`);

    const two = translateChat(ctx, [system('x'), user('Go again.')]);
    two.systemPrompt = ['Reply with exactly the single word GREEN and nothing else.'];
    const resumed = await chat(ctx, two, resumePlan(firstTurn.plan));
    mustReply('resumed turn', resumed);
    const word = expected(ctx, 'GREEN', 'PURPLE');
    assert(has(resumed.text, word) && !has(resumed.text, 'BLUE'), `the changed system prompt did not apply on resume (wanted ${word}): ${quote(resumed.text)}`);
    return `resumed reply ${quote(resumed.text, 40)}`;
  },
};

export const check12: Check = {
  id: '12',
  title: 'a missing session returns "No conversation found"',
  cost: 'Haiku, no tokens used',
  async run(ctx) {
    const t = translateChat(ctx, [system('Keep replies short.'), user('Hello')]);
    const missing = randomUUID();
    const result = await chat(ctx, t, {
      case: 'B', sessionId: missing, sessionStore: new MemorySessionStore(), resume: missing, lockKey: null,
    });
    assert(result.error !== null, `resuming a missing session produced a reply: ${quote(result.text)}`);
    const code = expected(ctx, 'session-stale', 'upstream');
    assert(result.error.code === code, `expected ${code}, got ${result.error.code}: ${quote(result.error.message)}`);
    assert(result.error.message.startsWith('No conversation found'), `message does not start with "No conversation found": ${quote(result.error.message)}`);
    return quote(result.error.message, 70);
  },
};

export const check15: Check = {
  id: '15',
  title: 'a retired model (claude-opus-4-1) still trips the model guard',
  cost: 'stops at init, no model call',
  async run(ctx) {
    const retired = 'claude-opus-4-1';
    const t = withModel(translateChat(ctx, [system('Keep replies short.'), user('Say ok.')]), retired);
    const result = await chat(ctx, t, newPlan());
    if (result.finishReason !== null) {
      throw new Failure(`${retired} was answered (model ${String(result.startedModel)}) instead of tripping the guard`);
    }
    if (result.error?.code === 'model-mismatch') {
      const want = expected(ctx, 'model-mismatch', 'upstream');
      assert(result.error.code === want, `expected ${want}, got ${result.error.code}`);
      return quote(result.error.message, 90);
    }
    throw new Skip(`${retired} is no longer silently substituted: ${result.error?.code} ${quote(result.error?.message ?? '', 80)}; the guard is not exercised`);
  },
};

export const check16: Check = {
  id: '16',
  title: 'a <synthetic> local reply (/help with verbatimPrompts off) is never sent as a reply',
  cost: 'Haiku, no tokens used',
  async run(ctx) {
    const t = translateChat(ctx, [system('Keep replies short.'), user('/help')]);
    // The runner's own query function, with only verbatimPrompts turned off so Claude Code answers locally.
    const local: QueryFn = (params) => sdkQuery({ ...params, options: { ...params.options, verbatimPrompts: false } });
    const plan = newPlan();
    const events = [];
    for await (const event of run({ translated: t, plan, config: ctx.config, signal: new AbortController().signal }, local)) events.push(event);
    const result = summarize(plan, events);
    assert(result.text === '', `local text reached the reply: ${quote(result.text)}`);
    const code = expected(ctx, 'intercepted-command', 'upstream');
    assert(result.error?.code === code, `expected ${code}, got ${result.error?.code ?? `a ${result.finishReason} finish`}`);
    return `${result.error!.code}: ${quote(result.error!.message, 60)}`;
  },
};
