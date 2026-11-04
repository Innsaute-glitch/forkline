import { describe, expect, it } from 'vitest';
import { createLogger } from '../../logger.js';
import { goldenConfig, readFixture } from '../../test/helpers.js';
import type { TranslatedRequest } from '../../types.js';
import { createRouter } from '../index.js';
import { MemorySessionStore } from '../memory-store.js';

const router = () => createRouter(goldenConfig(), createLogger('silent'));

describe('router v0', () => {
  it('routes an empty history to case A with an empty store', async () => {
    const t = readFixture<TranslatedRequest>('golden/translated/first-message-plain.json');
    expect(t.history).toEqual([]);
    const plan = await router().route(t);
    expect(plan).toMatchObject({ case: 'A', lockKey: null });
    expect(plan.resume).toBeUndefined();
    expect(plan.forkSession).toBeUndefined();
    expect(await plan.sessionStore.load({ projectKey: 'x', sessionId: plan.sessionId })).toBeNull();
  });

  it('routes any other history to case D with the session seeded', async () => {
    const t = readFixture<TranslatedRequest>('golden/translated/mid-system-consecutive.json');
    const plan = await router().route(t);
    expect(plan.case).toBe('D');
    expect(plan.resume).toBe(plan.sessionId);
    expect(plan.lockKey).toBeNull();
    const entries = await plan.sessionStore.load({ projectKey: 'ignored', sessionId: plan.sessionId });
    expect(entries).toHaveLength(t.history.length);
    expect(entries?.[0]).toMatchObject({ sessionId: plan.sessionId, parentUuid: null });
  });

  it('gives each request its own session and store, also after forceRebuild', async () => {
    const t = readFixture<TranslatedRequest>('golden/translated/edit.json');
    const r = router();
    const first = await r.route(t);
    const second = await r.route(t, { forceRebuild: true });
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.sessionStore).not.toBe(first.sessionStore);
    await expect(r.record({ translated: t, plan: first, replyText: 'x' })).resolves.toBeUndefined();
    expect(() => r.close()).not.toThrow();
  });
});

describe('MemorySessionStore', () => {
  const key = { projectKey: 'p', sessionId: 's' };
  it('keeps call order and de-duplicates by uuid, but always appends entries without one', async () => {
    const store = new MemorySessionStore();
    await store.append(key, [{ type: 'user', uuid: 'a' }, { type: 'mode' }]);
    await store.append({ ...key, projectKey: 'other' }, [{ type: 'user', uuid: 'a' }, { type: 'assistant', uuid: 'b' }, { type: 'mode' }]);
    const types = (await store.load(key))?.map((e) => `${e.type}:${e.uuid ?? ''}`);
    expect(types).toEqual(['user:a', 'mode:', 'assistant:b', 'mode:']);
  });
  it('returns null for an unknown session and ignores subpath keys', async () => {
    const store = new MemorySessionStore();
    expect(await store.load(key)).toBeNull();
    await store.append({ ...key, subpath: 'subagents/agent-1' }, [{ type: 'user', uuid: 'a' }]);
    expect(await store.load(key)).toBeNull();
    expect(await store.load({ ...key, subpath: 'subagents/agent-1' })).toBeNull();
  });
});
