import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADJUSTMENT_HEADER, SDK_VERSION } from '../../constants.js';
import { toErrorBody } from '../../errors.js';
import { latestRateLimits } from '../../runner/index.js';
import { translate } from '../../translator/index.js';
import type { RateLimitSnapshot, RunEvent } from '../../types.js';
import {
  API_KEY,
  AUTH,
  CONTENT_SENTINEL,
  deferred,
  events,
  fakeRouter,
  makeConfig,
  newRunState,
  planFor,
  replay,
  streamCalls,
  translatedFixture,
} from './fakes.js';
import { chatBody, health, installTranslate, makeApp, postChat } from './harness.js';

vi.mock('../../translator/index.js', () => ({ translate: vi.fn() }));
vi.mock('../../stream/index.js', async () => {
  const fakes = await import('./fakes.js');
  return { toSse: fakes.fakeToSse, toCompletion: fakes.fakeToCompletion };
});
vi.mock('../../runner/index.js', () => ({ latestRateLimits: vi.fn(() => null), run: vi.fn() }));

beforeEach(() => {
  vi.mocked(translate).mockReset();
  vi.mocked(latestRateLimits).mockReset().mockReturnValue(null);
  installTranslate();
  streamCalls.toSse = 0;
  streamCalls.toCompletion = 0;
});

const adjustmentsOf = (headers: Record<string, unknown>) => headers[ADJUSTMENT_HEADER.toLowerCase()];
const expectedAdjustments = translatedFixture().adjustments.join(',');

describe('auth', () => {
  it('rejects a missing, wrong or malformed key on every route with the error body', async () => {
    const { app, requests } = makeApp();
    for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: API_KEY }, { authorization: 'Bearer' }]) {
      for (const [method, url] of [
        ['GET', '/health'],
        ['GET', '/v1/models'],
        ['POST', '/v1/chat/completions'],
        ['GET', '/nowhere'],
      ] as const) {
        const res = await app.inject({ method, url, headers, payload: method === 'POST' ? '{}' : undefined });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual(toErrorBody({ code: 'unauthorized', status: 401, message: 'missing or invalid API key' }));
      }
    }
    expect(vi.mocked(translate)).not.toHaveBeenCalled();
    expect(requests()).toHaveLength(0);
  });

  it('accepts the right key', async () => {
    const { app } = makeApp();
    expect((await app.inject({ method: 'GET', url: '/health', headers: AUTH })).statusCode).toBe(200);
  });
});

describe('simple routes', () => {
  it('404 with the error body for an unknown route', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/v1/nothing', headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ type: 'not-found', code: 404 });
  });

  it('lists models in config order', async () => {
    const { app, config } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/v1/models', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      object: 'list',
      data: config.models.map((m) => ({ id: m.id, object: 'model', created: 0, owned_by: 'forkline' })),
    });
  });

  it('health shape, with rate limits read from the runner', async () => {
    const snapshot: RateLimitSnapshot = {
      five_hour: { status: 'allowed', utilization: 0.4, resetsAt: 1800000000, updatedAt: '2026-11-04T00:00:00.000Z' },
    };
    vi.mocked(latestRateLimits).mockReturnValue(snapshot);
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/health', headers: AUTH });
    expect(res.json()).toEqual({ status: 'ok', engine: { sdk: SDK_VERSION }, active: 0, queued: 0, rateLimits: snapshot });
    vi.mocked(latestRateLimits).mockReturnValue(null);
    expect((await app.inject({ method: 'GET', url: '/health', headers: AUTH })).json().rateLimits).toBeNull();
  });

  it('413 for a body over the limit, with one request line', async () => {
    const { app, requests } = makeApp({ config: makeConfig({ limits: { bodyBytes: 200 } }) });
    const res = await postChat(app, chatBody({ messages: [{ role: 'user', content: 'x'.repeat(500) }] }));
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatchObject({ type: 'body-too-large', code: 413 });
    expect(requests()).toHaveLength(1);
    expect(requests()[0]).toMatchObject({ status: 413, errorCode: 'body-too-large' });
  });

  it('400 for invalid JSON and for a non-object body', async () => {
    const { app } = makeApp();
    const bad = await postChat(app, '{not json');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.type).toBe('invalid-request');
    const arr = await postChat(app, '[1,2]');
    expect(arr.statusCode).toBe(400);
    expect(arr.json().error.type).toBe('invalid-request');
    expect(vi.mocked(translate)).not.toHaveBeenCalled();
  });
});

describe('chat flow', () => {
  it('translate failure returns its error, no adjustments header, takes no slot, one log line', async () => {
    const { app, router, requests } = makeApp();
    const res = await postChat(app, chatBody({ _fail: true }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toEqual({ message: 'bad request', type: 'invalid-request', code: 400 });
    expect(adjustmentsOf(res.headers)).toBeUndefined();
    expect(router.route).not.toHaveBeenCalled();
    expect(requests()).toHaveLength(1);
    expect((await health(app)).active).toBe(0);
  });

  it('error before started: real status, JSON body, Retry-After, adjustments header, no SSE', async () => {
    const { app, router, requests } = makeApp({ run: replay(events('error-before-start')) });
    const res = await postChat(app, chatBody({ stream: true }));
    expect(res.statusCode).toBe(429);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['retry-after']).toBe('3600');
    expect(adjustmentsOf(res.headers)).toBe(expectedAdjustments);
    expect(res.json().error).toEqual({ message: 'Usage limit reached', type: 'usage-limit', code: 429 });
    expect(streamCalls.toSse).toBe(0);
    expect(router.record).not.toHaveBeenCalled();
    expect(requests()).toHaveLength(1);
    expect(requests()[0]).toMatchObject({ status: 429, errorCode: 'usage-limit', stream: true, routeCase: 'D' });
    expect((await health(app)).active).toBe(0);
  });

  it('streams: 200 on started, adjustments header, record called with the reply', async () => {
    const { app, router, requests } = makeApp({ run: replay(events('plain-text')) });
    const res = await postChat(app, chatBody({ stream: true }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(adjustmentsOf(res.headers)).toBe(expectedAdjustments);
    expect(res.body.trim().endsWith('data: [DONE]')).toBe(true);
    expect(router.record).toHaveBeenCalledTimes(1);
    const recorded = router.record.mock.calls[0]![0];
    const expectedText = events('plain-text')
      .filter((e): e is Extract<RunEvent, { type: 'text' }> => e.type === 'text')
      .map((e) => e.text)
      .join('');
    expect(recorded.replyText).toBe(expectedText);
    expect(recorded.translated.claudeModel).toBe(translatedFixture().claudeModel);
    const line = requests()[0]!;
    expect(line).toMatchObject({ status: 200, stream: true, routeCase: 'D', errorCode: null, route: '/v1/chat/completions' });
    expect(line.usage).toEqual({ input: expect.any(Number), output: expect.any(Number), cacheRead: expect.any(Number), cacheWrite: expect.any(Number) });
    expect(typeof line.firstByteMs).toBe('number');
    expect(line.adjustments).toEqual(translatedFixture().adjustments);
  });

  it('non-streaming success: 200 with the body, record called', async () => {
    const { app, router, requests } = makeApp({ run: replay(events('plain-text')) });
    const res = await postChat(app, chatBody());
    expect(res.statusCode).toBe(200);
    expect(res.json().object).toBe('chat.completion');
    expect(res.json().model).toBe('m');
    expect(adjustmentsOf(res.headers)).toBe(expectedAdjustments);
    expect(router.record).toHaveBeenCalledTimes(1);
    expect(requests()[0]).toMatchObject({ status: 200, stream: false });
  });

  it('sends the header even when there are no adjustments (empty value)', async () => {
    const { app } = makeApp();
    const res = await postChat(app, chatBody({ _adjustments: [] }));
    expect(res.statusCode).toBe(200);
    expect(adjustmentsOf(res.headers)).toBe('');
  });

  it('non-streaming error after started gets its real status and the header', async () => {
    const { app, router, requests } = makeApp({ run: replay(events('error-after-start')) });
    const res = await postChat(app, chatBody());
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toEqual({ message: 'reply exceeded max_tokens', type: 'output-limit', code: 400 });
    expect(adjustmentsOf(res.headers)).toBe(expectedAdjustments);
    expect(router.record).not.toHaveBeenCalled();
    expect(requests()[0]).toMatchObject({ status: 400, errorCode: 'output-limit' });
  });

  it('streaming error after started keeps status 200, skips record, logs the error code', async () => {
    const { app, router, requests } = makeApp({ run: replay(events('error-after-start')) });
    const res = await postChat(app, chatBody({ stream: true }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('output-limit');
    expect(router.record).not.toHaveBeenCalled();
    expect(requests()[0]).toMatchObject({ status: 200, errorCode: 'output-limit' });
  });

  it.each([
    ['stream', true],
    ['non-stream', false],
  ])('skips record after a stop match (%s) and aborts the run signal', async (_name, stream) => {
    const state = newRunState();
    const { app, router, requests } = makeApp({ run: replay(events('text-with-stop'), {}, state) });
    const res = await postChat(app, chatBody({ stream, _stop: ['\nUser:'] }));
    expect(res.statusCode).toBe(200);
    expect(state.inputs[0]!.signal.aborted).toBe(true);
    expect(router.record).not.toHaveBeenCalled();
    expect(requests()).toHaveLength(1);
  });

  it('skips record unless the run finished with stop (length, content_filter)', async () => {
    for (const reasonEvents of [
      events('refusal'),
      events('plain-text').map((e) => (e.type === 'finished' ? { ...e, finishReason: 'length' as const } : e)),
    ]) {
      const { app, router } = makeApp({ run: replay(reasonEvents) });
      expect((await postChat(app, chatBody({ stream: true }))).statusCode).toBe(200);
      expect((await postChat(app, chatBody())).statusCode).toBe(200);
      expect(router.record).not.toHaveBeenCalled();
    }
  });

  it('a failing record does not change the response', async () => {
    const router = fakeRouter();
    router.record.mockRejectedValue(new Error('disk full'));
    const { app, lines } = makeApp({ router });
    expect((await postChat(app, chatBody({ stream: true }))).statusCode).toBe(200);
    expect(lines.some((l) => l.msg === 'record failed')).toBe(true);
  });

  it('a run that ends with no event and no abort is a 502', async () => {
    const { app, requests } = makeApp({ run: replay([]) });
    const res = await postChat(app, chatBody());
    expect(res.statusCode).toBe(502);
    expect(res.json().error.type).toBe('upstream');
    expect(adjustmentsOf(res.headers)).toBe(expectedAdjustments);
    expect(requests()).toHaveLength(1);
  });
});

describe('session-stale', () => {
  const stale: RunEvent = {
    type: 'error',
    error: { code: 'session-stale', status: 502, message: 'No conversation found' },
  };

  it('reruns once with a forced rebuild on a new plan', async () => {
    const plans = [planFor(null, 'aaaaaaaa-0000-4000-8000-000000000001'), planFor(null, 'aaaaaaaa-0000-4000-8000-000000000002')];
    const router = fakeRouter();
    router.route.mockResolvedValueOnce(plans[0]!).mockResolvedValueOnce(plans[1]!);
    const state = newRunState();
    const good = events('plain-text');
    let call = 0;
    const run = (input: Parameters<ReturnType<typeof replay>>[0]) => {
      call += 1;
      return replay(call === 1 ? [stale] : good, {}, state)(input);
    };
    const { app, requests } = makeApp({ run, router });
    const res = await postChat(app, chatBody({ stream: true }));
    expect(res.statusCode).toBe(200);
    expect(state.inputs).toHaveLength(2);
    expect(state.inputs[0]!.plan).toBe(plans[0]);
    expect(state.inputs[1]!.plan).toBe(plans[1]);
    expect(router.route).toHaveBeenCalledTimes(2);
    expect(router.route.mock.calls[0]![1]).toBeUndefined();
    expect(router.route.mock.calls[1]![1]).toEqual({ forceRebuild: true });
    expect(router.record.mock.calls[0]![0].plan).toBe(plans[1]);
    expect(requests()).toHaveLength(1);
  });

  it('does not rerun a second time: a second stale is returned as the error', async () => {
    const state = newRunState();
    const { app, router, requests } = makeApp({ run: replay([stale], {}, state) });
    const res = await postChat(app, chatBody({ stream: true }));
    expect(res.statusCode).toBe(502);
    expect(res.json().error.type).toBe('session-stale');
    expect(state.inputs).toHaveLength(2);
    expect(router.route).toHaveBeenCalledTimes(2);
    expect(requests()).toHaveLength(1);
  });

  it('swaps locks: releases the old key, takes the new one', async () => {
    const gate = deferred();
    const router = fakeRouter(async (t, opts) => planFor(opts?.forceRebuild ? 'k2' : t.responseModel === 'A' ? 'k1' : null, undefined));
    // B shares lock k1 with A's first plan.
    router.route.mockImplementation(async (t, opts) =>
      planFor(opts?.forceRebuild ? 'k2' : t.responseModel === 'A' || t.responseModel === 'B' ? 'k1' : null),
    );
    let aCalls = 0;
    const run = (input: Parameters<ReturnType<typeof replay>>[0]) => {
      if (input.translated.responseModel === 'A') {
        aCalls += 1;
        return replay(aCalls === 1 ? [stale] : events('plain-text'), { gate, gateAt: 1 })(input);
      }
      return replay(events('plain-text'))(input);
    };
    const { app } = makeApp({ run, router });
    const a = postChat(app, chatBody({ model: 'A' }));
    // Wait until A is gated in its second run (holding k2, k1 released).
    await vi.waitFor(() => expect(aCalls).toBe(2));
    const b = await postChat(app, chatBody({ model: 'B' }));
    expect(b.statusCode).toBe(200);
    expect(router.route.mock.calls.filter(([t]) => t.responseModel === 'B')).toHaveLength(1);
    gate.resolve();
    expect((await a).statusCode).toBe(200);
    expect((await health(app)).active).toBe(0);
  });
});

describe('limiter in the flow', () => {
  it('503 queue-full when no slot and no queue room, with the adjustments header', async () => {
    const gate = deferred();
    const config = makeConfig({ concurrency: { maxActive: 1, maxQueued: 0, queueTimeoutMs: 1000 } });
    const { app, requests } = makeApp({ config, run: replay(events('plain-text'), { gate, gateAt: 1 }) });
    const a = postChat(app, chatBody());
    await vi.waitFor(async () => expect((await health(app)).active).toBe(1));
    const b = await postChat(app, chatBody());
    expect(b.statusCode).toBe(503);
    expect(b.json().error.type).toBe('queue-full');
    expect(adjustmentsOf(b.headers)).toBe(expectedAdjustments);
    gate.resolve();
    expect((await a).statusCode).toBe(200);
    expect(requests()).toHaveLength(2);
    expect(requests().map((r) => r.status).sort()).toEqual([200, 503]);
    expect(await health(app)).toMatchObject({ active: 0, queued: 0 });
  });

  it('a queued request runs when a slot frees up, and routes only then (nothing seeded while rejected)', async () => {
    const gate = deferred();
    const config = makeConfig({ concurrency: { maxActive: 1, maxQueued: 1, queueTimeoutMs: 5000 } });
    const router = fakeRouter();
    const { app } = makeApp({ config, router, run: replay(events('plain-text'), { gate, gateAt: 1 }) });
    const a = postChat(app, chatBody());
    await vi.waitFor(async () => expect((await health(app)).active).toBe(1));
    const b = postChat(app, chatBody());
    await vi.waitFor(async () => expect((await health(app)).queued).toBe(1));
    expect(router.route).toHaveBeenCalledTimes(1);
    gate.resolve();
    expect((await a).statusCode).toBe(200);
    expect((await b).statusCode).toBe(200);
    expect(router.route).toHaveBeenCalledTimes(2);
  });

  it('503 when the queue wait times out', async () => {
    const gate = deferred();
    const config = makeConfig({ concurrency: { maxActive: 1, maxQueued: 1, queueTimeoutMs: 40 } });
    const router = fakeRouter();
    const { app } = makeApp({ config, router, run: replay(events('plain-text'), { gate, gateAt: 1 }) });
    const a = postChat(app, chatBody());
    await vi.waitFor(async () => expect((await health(app)).active).toBe(1));
    const b = await postChat(app, chatBody());
    expect(b.statusCode).toBe(503);
    expect(router.route).toHaveBeenCalledTimes(1);
    gate.resolve();
    await a;
    expect(await health(app)).toMatchObject({ active: 0, queued: 0 });
  });
});

describe('lockKey (v0 passes null; Task 5 will not change HTTP)', () => {
  it('after a lock wait the request routes again, runs on the new plan and swaps locks', async () => {
    const gate = deferred();
    const state = newRunState();
    const planA = planFor('k', 'aaaaaaaa-0000-4000-8000-00000000000a');
    const planB1 = planFor('k', 'bbbbbbbb-0000-4000-8000-000000000001');
    const planB2 = planFor('k2', 'bbbbbbbb-0000-4000-8000-000000000002');
    const router = fakeRouter();
    const planC = planFor('k', 'cccccccc-0000-4000-8000-000000000001');
    const gateB = deferred();
    router.route
      .mockResolvedValueOnce(planA)
      .mockResolvedValueOnce(planB1)
      .mockResolvedValueOnce(planB2)
      .mockResolvedValueOnce(planC);
    const run = (input: Parameters<ReturnType<typeof replay>>[0]) =>
      input.plan === planA
        ? replay(events('plain-text'), { gate, gateAt: 1 }, state)(input)
        : input.plan === planB2
          ? replay(events('plain-text'), { gate: gateB, gateAt: 1 }, state)(input)
          : replay(events('plain-text'), {}, state)(input);
    const { app } = makeApp({ run, router, config: makeConfig({ concurrency: { maxActive: 2, maxQueued: 2, queueTimeoutMs: 5000 } }) });
    const a = postChat(app, chatBody());
    await vi.waitFor(() => expect(state.inputs).toHaveLength(1));
    const b = postChat(app, chatBody());
    await vi.waitFor(async () => expect((await health(app)).active).toBe(2));
    await vi.waitFor(() => expect(router.route).toHaveBeenCalledTimes(2));
    // B holds a slot and waits for the lock on k: it has not run, nor routed a second time.
    await new Promise((r) => setTimeout(r, 30));
    expect(state.inputs).toHaveLength(1);
    expect(router.route).toHaveBeenCalledTimes(2);
    gate.resolve();
    expect((await a).statusCode).toBe(200);
    await vi.waitFor(() => expect(state.inputs).toHaveLength(2));
    expect(router.route).toHaveBeenCalledTimes(3);
    expect(state.inputs[1]!.plan).toBe(planB2);
    // B swapped to k2: a request on the old key k is no longer blocked by B (still running).
    expect((await postChat(app, chatBody())).statusCode).toBe(200);
    gateB.resolve();
    expect((await b).statusCode).toBe(200);
    expect(router.record.mock.calls.map((c) => c[0].plan)).toEqual([planA, planC, planB2]);
    expect(await health(app)).toMatchObject({ active: 0, queued: 0 });
  });

  it('releases the lock on every path (a following request on the same key is not blocked)', async () => {
    const router = fakeRouter(async () => planFor('same'));
    const { app } = makeApp({ router, run: replay(events('error-before-start')) });
    expect((await postChat(app, chatBody())).statusCode).toBe(429);
    expect((await postChat(app, chatBody())).statusCode).toBe(429);
    expect(router.route).toHaveBeenCalledTimes(2);
  });
});

describe('every path releases the slot and writes one request line', () => {
  const stale: RunEvent = { type: 'error', error: { code: 'session-stale', status: 502, message: 'x' } };
  const scenarios: [string, () => Parameters<typeof makeApp>[0], unknown, number][] = [
    ['translate failure', () => ({}), chatBody({ _fail: true }), 400],
    ['non-object body', () => ({}), '[]', 400],
    ['error before start', () => ({ run: replay(events('error-before-start')) }), chatBody(), 429],
    ['stream success', () => ({}), chatBody({ stream: true }), 200],
    ['non-stream success', () => ({}), chatBody(), 200],
    ['stream error after start', () => ({ run: replay(events('error-after-start')) }), chatBody({ stream: true }), 200],
    ['non-stream error after start', () => ({ run: replay(events('error-after-start')) }), chatBody(), 400],
    ['empty run', () => ({ run: replay([]) }), chatBody(), 502],
    ['route throws', () => ({ router: fakeRouter(async () => { throw new Error('db down'); }) }), chatBody(), 502],
    ['run throws', () => ({ run: () => { throw new Error('boom'); } }), chatBody({ stream: true }), 502],
    ['double stale', () => ({ run: replay([stale]) }), chatBody(), 502],
    ['lock held then error', () => ({ router: fakeRouter(async () => planFor('k')), run: replay(events('error-before-start')) }), chatBody(), 429],
  ];
  it.each(scenarios)('%s', async (_name, options, body, status) => {
    const { app, requests } = makeApp(options());
    const res = await postChat(app, body);
    expect(res.statusCode).toBe(status);
    expect(requests()).toHaveLength(1);
    expect(requests()[0]!.status).toBe(status);
    expect(await health(app)).toMatchObject({ active: 0, queued: 0 });
    // A new request still gets through (no slot or lock leaked).
    expect((await app.inject({ method: 'GET', url: '/v1/models', headers: AUTH })).statusCode).toBe(200);
  });
});

describe('logging', () => {
  it('never logs message content or the API key', async () => {
    const { app, lines } = makeApp();
    await postChat(app, chatBody({ stream: true }));
    await postChat(app, chatBody({ _fail: true }));
    await app.inject({ method: 'GET', url: '/health', headers: { authorization: `Bearer ${API_KEY}x` } });
    const dump = JSON.stringify(lines);
    expect(dump).not.toContain(CONTENT_SENTINEL);
    expect(dump).not.toContain(API_KEY);
  });

  it('logs request bodies only when debug.captureBodies is on', async () => {
    const off = makeApp();
    await postChat(off.app, chatBody());
    expect(JSON.stringify(off.lines)).not.toContain(CONTENT_SENTINEL);
    const on = makeApp({ config: makeConfig({ debug: { captureBodies: true } }) });
    await postChat(on.app, chatBody());
    expect(on.lines.filter((l) => JSON.stringify(l).includes(CONTENT_SENTINEL))).toHaveLength(1);
  });
});

describe('shutdown', () => {
  it('calls router.close on close', async () => {
    const { app, router } = makeApp();
    await app.close();
    expect(router.close).toHaveBeenCalledTimes(1);
  });

  it('aborts runs still going after the grace period', async () => {
    const gate = deferred();
    const state = newRunState();
    const { app, router } = makeApp({ shutdownGraceMs: 50, run: replay(events('plain-text'), { gate, gateAt: 1 }, state) });
    const pending = postChat(app, chatBody());
    await vi.waitFor(() => expect(state.inputs).toHaveLength(1));
    await app.close();
    expect(state.inputs[0]!.signal.aborted).toBe(true);
    expect(router.close).toHaveBeenCalledTimes(1);
    await pending.catch(() => {});
  });
});
