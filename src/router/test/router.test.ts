import { describe, expect, it } from 'vitest';
import { INJECTED_TEXT_FILLER } from '../../constants.js';
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
    // goldenConfig has no model identity, so the seeds are environment and date only.
    expect(entries).toHaveLength(t.history.length + 2);
    expect(entries?.[0]).toMatchObject({ sessionId: plan.sessionId, parentUuid: null });
  });

  it('chains seeds after the history, using the model identity from config', async () => {
    const config = goldenConfig();
    config.models[0] = { ...config.models[0]!, marketingName: 'Sonnet 5.5', knowledgeCutoff: 'June 2026' };
    const t = readFixture<TranslatedRequest>('golden/translated/edit.json');
    const plan = await createRouter(config, createLogger('silent')).route(t);
    const entries = (await plan.sessionStore.load({ projectKey: 'x', sessionId: plan.sessionId }))!;
    const seeds = entries.slice(t.history.length);
    const attachment = (index: number) => seeds[index]!.attachment as Record<string, unknown>;
    expect(seeds.map((seed) => attachment(seeds.indexOf(seed)).type)).toEqual(['environment', 'model', 'date']);
    expect(attachment(1).identity).toEqual({ modelId: t.claudeModel, marketingName: 'Sonnet 5.5', knowledgeCutoff: 'June 2026' });
    expect(attachment(2).date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const [index, seed] of seeds.entries()) {
      expect(seed.parentUuid).toBe(entries[t.history.length + index - 1]!.uuid);
      expect(seed.rendered).toEqual([{ content: INJECTED_TEXT_FILLER }]);
      expect(seed.renderedRole).toBe('system');
    }
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
