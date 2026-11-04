import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collect, goldenConfig, readFixture } from '../../test/helpers.js';
import type { RoutePlan, RunEvent, TranslatedRequest } from '../../types.js';
import { latestRateLimits, resetRateLimits } from '../rate-limits.js';
import { run, type QueryFn, type RunInput } from '../run.js';

type Msg = Record<string, unknown>;
const MODEL = 'claude-sonnet-5-5';
const init = (model = MODEL): Msg => ({ type: 'system', subtype: 'init', model });
const start = (model = MODEL): Msg => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { model } } });
const delta = (d: Msg): Msg => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: d } });
const text = (t: string) => delta({ type: 'text_delta', text: t });
const think = (t: string) => delta({ type: 'thinking_delta', thinking: t });
const USAGE = { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 3000, cache_creation_input_tokens: 25 };
const ok = (over: Msg = {}): Msg => ({ type: 'result', subtype: 'success', is_error: false, result: 'full text', stop_reason: 'end_turn', usage: USAGE, ...over });

function input(signal = new AbortController().signal, config = goldenConfig()): RunInput {
  const translated = readFixture<TranslatedRequest>('golden/translated/greeting-lorebook.json');
  const plan: RoutePlan = { case: 'D', sessionId: 'sid', resume: 'sid', lockKey: null, sessionStore: { append: async () => {}, load: async () => null } };
  return { translated, plan, config, signal };
}

interface Fake { fn: QueryFn; closed: () => number; calls: () => number }
/** A fake `query`: yields the messages in order; a function entry runs a side effect or waits. */
function fake(script: Array<Msg | (() => Promise<void> | void)>, opts: { throwAfter?: Error } = {}): Fake {
  let closed = 0;
  let calls = 0;
  const fn: QueryFn = ({ options }) => {
    calls++;
    const aborted = new Promise<never>((_, reject) => options?.abortController?.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    aborted.catch(() => {});
    const gen = (async function* () {
      for (const step of script) {
        if (typeof step === 'function') await Promise.race([step(), aborted]);
        else yield step as unknown as SDKMessage;
      }
      if (opts.throwAfter) throw opts.throwAfter;
    })();
    return Object.assign(gen, { close: () => { closed++; } }) as unknown as Query;
  };
  return { fn, closed: () => closed, calls: () => calls };
}
const never = () => new Promise<void>(() => {});
const types = (events: RunEvent[]) => events.map((e) => e.type);

afterEach(() => { vi.useRealTimers(); resetRateLimits(); });

describe('run', () => {
  it('maps stream deltas to started, reasoning, text and finished', async () => {
    const f = fake([init(), start(), think('hm'), text('Hel'), text('lo'), { type: 'assistant', message: { model: MODEL, content: [{ type: 'text', text: 'ignored copy' }] } }, ok()]);
    const events = await collect(run(input(), f.fn));
    expect(events).toEqual([
      { type: 'started', sessionId: 'sid', model: MODEL },
      { type: 'reasoning', text: 'hm' },
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'finished', sessionId: 'sid', finishReason: 'stop', usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 3000, cacheWriteTokens: 25 } },
    ]);
    expect(f.closed()).toBe(1);
  });

  it('never reads reply text from assistant or result messages', async () => {
    const f = fake([init(), start(), { type: 'assistant', message: { model: MODEL, content: [{ type: 'text', text: 'local' }] } }, ok({ result: 'local' })]);
    const events = await collect(run(input(), f.fn));
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'upstream', message: 'model returned an empty reply' } });
    expect(events.some((e) => e.type === 'text')).toBe(false);
  });

  it('emits the terminal event only after the iterator ends', async () => {
    const order: string[] = [];
    const f = fake([init(), start(), text('x'), ok(), () => { order.push('iterator still running after result'); }]);
    const gen = run(input(), f.fn);
    for await (const e of gen) order.push(e.type);
    expect(order).toEqual(['started', 'text', 'iterator still running after result', 'finished']);
  });

  it('accepts the dated served model and trips on a mismatch at init, before any event but the error', async () => {
    const dated = fake([init(`${MODEL}-20251001`), start(`${MODEL}-20251001`), text('a'), ok()]);
    expect(types(await collect(run(input(), dated.fn)))).toEqual(['started', 'text', 'finished']);
    const bad = fake([init('claude-opus-5-5'), start('claude-opus-5-5'), text('a'), ok()]);
    const events = await collect(run(input(), bad.fn));
    expect(events).toEqual([{ type: 'error', error: expect.objectContaining({ code: 'model-mismatch', status: 502 }) }]);
    expect(bad.closed()).toBe(1);
  });

  it('trips on a mismatch at message_start and stops reading', async () => {
    const f = fake([init(), start('claude-haiku-5-5'), text('leak'), ok()]);
    const events = await collect(run(input(), f.fn));
    expect(events).toEqual([{ type: 'error', error: expect.objectContaining({ code: 'model-mismatch' }) }]);
  });

  it('starts once even when Claude Code makes several model calls', async () => {
    const f = fake([init(), start(), text('a'), start(), text('b'), ok()]);
    expect(types(await collect(run(input(), f.fn)))).toEqual(['started', 'text', 'text', 'finished']);
  });

  it('ignores subagent stream events', async () => {
    const sub = { ...text('sub'), parent_tool_use_id: 'tool_1' };
    const f = fake([init(), start(), sub, text('a'), ok()]);
    const events = await collect(run(input(), f.fn));
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'a' }]);
  });

  it('turns an error result followed by a throw into one error, the result winning', async () => {
    const f = fake([init(), { type: 'system', subtype: 'api_retry' }, ok({ is_error: true, api_error_status: 429, api_error_code: 'credits_required', result: 'Fable 5 requires usage credits.', usage: { input_tokens: 0, output_tokens: 0 } })], { throwAfter: new Error('Claude Code returned an error result: Fable 5 requires usage credits.') });
    const events = await collect(run(input(), f.fn));
    expect(events).toEqual([{ type: 'error', error: { code: 'usage-limit', status: 429, message: 'Fable 5 requires usage credits.' } }]);
  });

  it('reports partial text followed by an output-limit error', async () => {
    const f = fake([init(), start(), text('partial'), { type: 'assistant', error: 'max_output_tokens', parent_tool_use_id: null, message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: exceeded' }] } }, ok({ is_error: true, api_error: 'max_output_tokens', result: 'API Error: exceeded' })], { throwAfter: new Error('Claude Code returned an error result: x') });
    const events = await collect(run(input(), f.fn));
    expect(types(events)).toEqual(['started', 'text', 'error']);
    expect(events.at(-1)).toMatchObject({ error: { code: 'output-limit', status: 400 } });
  });

  it('maps a missing session thrown with no result to session-stale', async () => {
    const f = fake([init()], { throwAfter: new Error('Claude Code returned an error result: No conversation found with session ID: x') });
    expect(await collect(run(input(), f.fn))).toEqual([{ type: 'error', error: expect.objectContaining({ code: 'session-stale' }) }]);
  });

  it('maps /help style local answers to intercepted-command', async () => {
    const f = fake([init(), { type: 'assistant', parent_tool_use_id: null, message: { model: '<synthetic>', content: [{ type: 'text', text: "/help isn't available" }] } }, ok({ result: "/help isn't available", usage: { input_tokens: 0, output_tokens: 0 } })]);
    expect(await collect(run(input(), f.fn))).toEqual([{ type: 'error', error: expect.objectContaining({ code: 'intercepted-command', status: 400 }) }]);
  });

  it('finishes a refusal with content_filter and does not send the refusal text', async () => {
    const f = fake([init(), start(), { type: 'system', subtype: 'model_refusal_no_fallback', content: 'refused text' }, ok({ is_error: true, result: 'refused text' })]);
    const events = await collect(run(input(), f.fn));
    expect(events).toEqual([
      { type: 'started', sessionId: 'sid', model: MODEL },
      { type: 'finished', sessionId: 'sid', finishReason: 'content_filter', usage: expect.any(Object) },
    ]);
  });

  it('ends with no terminal event when the signal aborts, and stops the subprocess', async () => {
    const controller = new AbortController();
    const f = fake([init(), start(), text('a'), never, ok()]);
    const events: RunEvent[] = [];
    for await (const e of run(input(controller.signal), f.fn)) {
      events.push(e);
      if (e.type === 'text') setTimeout(() => controller.abort(), 0);
    }
    expect(types(events)).toEqual(['started', 'text']);
    expect(f.closed()).toBe(1);
  });

  it('does not start when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const f = fake([init()]);
    expect(await collect(run(input(controller.signal), f.fn))).toEqual([]);
    expect(f.calls()).toBe(0);
  });

  it('return() stops the subprocess', async () => {
    const f = fake([init(), start(), text('a'), never]);
    const gen = run(input(), f.fn);
    expect((await gen.next()).value).toMatchObject({ type: 'started' });
    await gen.return(undefined);
    expect(f.closed()).toBe(1);
  });

  it('times out when the model never starts (deadline)', async () => {
    const config = { ...goldenConfig(), timeouts: { streamIdleMs: 50, deadlineMs: 80 } };
    const f = fake([init(), never]);
    const events = await collect(run(input(undefined, config), f.fn));
    expect(events).toEqual([{ type: 'error', error: expect.objectContaining({ code: 'timeout', status: 504 }) }]);
    expect(f.closed()).toBe(1);
  });

  it('times out on silence while streaming (idle), and the idle timer is reset by every message', async () => {
    const config = { ...goldenConfig(), timeouts: { streamIdleMs: 60, deadlineMs: 5000 } };
    const pause = (ms: number) => () => new Promise<void>((r) => setTimeout(r, ms));
    const alive = fake([init(), start(), pause(40), text('a'), pause(40), text('b'), ok()]);
    expect(types(await collect(run(input(undefined, config), alive.fn)))).toEqual(['started', 'text', 'text', 'finished']);
    const stuck = fake([init(), start(), text('a'), never]);
    const events = await collect(run(input(undefined, config), stuck.fn));
    expect(types(events)).toEqual(['started', 'text', 'error']);
    expect(events.at(-1)).toMatchObject({ error: { code: 'timeout' } });
  });

  it('does not let the deadline cut a stream that has started', async () => {
    const config = { ...goldenConfig(), timeouts: { streamIdleMs: 1000, deadlineMs: 50 } };
    const pause = () => new Promise<void>((r) => setTimeout(r, 120));
    const f = fake([init(), start(), pause, text('a'), ok()]);
    expect(types(await collect(run(input(undefined, config), f.fn)))).toEqual(['started', 'text', 'finished']);
  });

  it('keeps the outcome when the iterator hangs after the result', async () => {
    const config = { ...goldenConfig(), timeouts: { streamIdleMs: 50, deadlineMs: 5000 } };
    const f = fake([init(), start(), text('a'), ok(), never]);
    expect(types(await collect(run(input(undefined, config), f.fn)))).toEqual(['started', 'text', 'finished']);
  });

  it('records rate limit events and logs mirror errors without changing the result', async () => {
    const f = fake([init(), { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.9, resetsAt: 5 } }, start(), text('a'), { type: 'system', subtype: 'mirror_error', error: 'e', key: { sessionId: 'sid' } }, ok()]);
    expect(types(await collect(run(input(), f.fn)))).toEqual(['started', 'text', 'finished']);
    expect(latestRateLimits()?.five_hour).toMatchObject({ status: 'allowed_warning', utilization: 0.9, resetsAt: 5 });
  });

  it('turns a query construction failure into an upstream error', async () => {
    const fn: QueryFn = () => { throw new Error('bad options'); };
    expect(await collect(run(input(), fn))).toEqual([{ type: 'error', error: expect.objectContaining({ code: 'upstream', message: 'bad options' }) }]);
  });
});
