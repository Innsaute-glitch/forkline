// Real-socket tests (ephemeral loopback port) for disconnects and header timing.
import http, { type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADJUSTMENT_HEADER } from '../../constants.js';
import { translate } from '../../translator/index.js';
import { AUTH, deferred, events, fakeRouter, makeConfig, newRunState, replay, translatedFixture } from './fakes.js';
import { chatBody, installTranslate, makeApp } from './harness.js';

vi.mock('../../translator/index.js', () => ({ translate: vi.fn() }));
vi.mock('../../stream/index.js', async () => {
  const fakes = await import('./fakes.js');
  return { toSse: fakes.fakeToSse, toCompletion: fakes.fakeToCompletion };
});
vi.mock('../../runner/index.js', () => ({ latestRateLimits: vi.fn(() => null), run: vi.fn() }));

const apps: { close: () => Promise<undefined> }[] = [];
beforeEach(() => {
  vi.mocked(translate).mockReset();
  installTranslate();
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function start(options: Parameters<typeof makeApp>[0]) {
  const made = makeApp({ shutdownGraceMs: 20, ...options });
  await made.app.listen({ host: '127.0.0.1', port: 0 });
  apps.push(made.app);
  const port = (made.app.server.address() as AddressInfo).port;
  return { ...made, port };
}

function postRaw(port: number, body: unknown) {
  const payload = JSON.stringify(body);
  const req = http.request({
    host: '127.0.0.1',
    port,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
  });
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    req.on('response', resolve);
    req.on('error', reject);
  });
  response.catch(() => {});
  req.end(payload);
  return { req, response };
}

const activeOf = async (port: number) => {
  const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: AUTH });
  return (await res.json()) as { active: number; queued: number };
};

describe('client disconnect', () => {
  it('streaming: 200 and the adjustments header arrive before the first text; disconnect aborts the run', async () => {
    const gate = deferred();
    const state = newRunState();
    const { port, router, requests } = await start({ run: replay(events('plain-text'), { gate, gateAt: 1 }, state) });
    const { req, response } = postRaw(port, chatBody({ stream: true }));
    const res = await response;
    // The run is still gated: headers came out at `started`, before any text.
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.headers[ADJUSTMENT_HEADER.toLowerCase()]).toBe(translatedFixture().adjustments.join(','));
    expect(state.inputs[0]!.signal.aborted).toBe(false);
    await new Promise((r) => res.once('data', r)); // the started frame
    req.destroy();
    res.destroy();
    await vi.waitFor(() => expect(state.inputs[0]!.signal.aborted).toBe(true));
    await vi.waitFor(() => expect(state.ended).toBe(1)); // the run generator was ended
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    expect(requests()[0]).toMatchObject({ status: 200, errorCode: 'client-disconnected' });
    expect(router.record).not.toHaveBeenCalled();
    expect(await activeOf(port)).toMatchObject({ active: 0, queued: 0 });
    gate.resolve();
  });

  it('non-streaming: disconnect while waiting sends nothing, logs once, frees the slot', async () => {
    const gate = deferred();
    const state = newRunState();
    const { port, router, requests } = await start({ run: replay(events('plain-text'), { gate, gateAt: 1 }, state) });
    const { req } = postRaw(port, chatBody());
    await vi.waitFor(() => expect(state.inputs).toHaveLength(1));
    req.destroy();
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    expect(state.inputs[0]!.signal.aborted).toBe(true);
    expect(requests()[0]).toMatchObject({ status: 499, errorCode: 'client-disconnected' });
    expect(router.record).not.toHaveBeenCalled();
    expect(await activeOf(port)).toMatchObject({ active: 0 });
  });

  it('an aborted run that ends with no events at all sends nothing', async () => {
    const gate = deferred(); // never resolved: the run ends only by the abort, before any event
    const state = newRunState();
    const { port, requests, router } = await start({ run: replay(events('plain-text'), { gate, gateAt: 0 }, state) });
    const { req } = postRaw(port, chatBody({ stream: true }));
    await vi.waitFor(() => expect(state.inputs).toHaveLength(1));
    req.destroy();
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    expect(requests()[0]).toMatchObject({ status: 499, errorCode: 'client-disconnected', firstByteMs: null });
    expect(router.record).not.toHaveBeenCalled();
    expect(await activeOf(port)).toMatchObject({ active: 0 });
  });

  it('a queued request whose client disconnects leaves the queue and never runs', async () => {
    const gate = deferred();
    const state = newRunState();
    const config = makeConfig({ concurrency: { maxActive: 1, maxQueued: 2, queueTimeoutMs: 5000 } });
    const router = fakeRouter();
    const { port, requests } = await start({ config, router, run: replay(events('plain-text'), { gate, gateAt: 1 }, state) });
    const a = postRaw(port, chatBody());
    await vi.waitFor(() => expect(state.inputs).toHaveLength(1));
    const b = postRaw(port, chatBody());
    await vi.waitFor(async () => expect((await activeOf(port)).queued).toBe(1));
    b.req.destroy();
    await vi.waitFor(async () => expect((await activeOf(port)).queued).toBe(0));
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    expect(requests()[0]).toMatchObject({ status: 499 });
    expect(router.route).toHaveBeenCalledTimes(1); // B was never routed
    gate.resolve();
    expect((await a.response).statusCode).toBe(200);
    expect(state.inputs).toHaveLength(1);
  });

  it('disconnect while waiting for a lock stops the wait', async () => {
    const gate = deferred();
    const state = newRunState();
    const config = makeConfig({ concurrency: { maxActive: 2, maxQueued: 2, queueTimeoutMs: 5000 } });
    const router = fakeRouter(async () => ({ ...(await import('./fakes.js')).planFor('k') }));
    const { port, requests } = await start({ config, router, run: replay(events('plain-text'), { gate, gateAt: 1 }, state) });
    const a = postRaw(port, chatBody());
    await vi.waitFor(() => expect(state.inputs).toHaveLength(1));
    const b = postRaw(port, chatBody());
    await vi.waitFor(() => expect(router.route).toHaveBeenCalledTimes(2));
    b.req.destroy();
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    expect(requests()[0]).toMatchObject({ status: 499 });
    gate.resolve();
    expect((await a.response).statusCode).toBe(200);
    expect(router.route).toHaveBeenCalledTimes(2); // no second route after the wait: B left
    expect(state.inputs).toHaveLength(1);
    expect(await activeOf(port)).toMatchObject({ active: 0 });
  });
});

describe('streaming over a real socket', () => {
  it('delivers the frames and calls record once the client stayed to the end', async () => {
    const { port, router } = await start({ run: replay(events('plain-text')) });
    const { response } = postRaw(port, chatBody({ stream: true }));
    const res = await response;
    let body = '';
    for await (const chunk of res) body += chunk.toString();
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
    await vi.waitFor(() => expect(router.record).toHaveBeenCalledTimes(1));
  });
});
