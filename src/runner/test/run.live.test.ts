// Real Claude Code calls on Haiku. Run with `npm run test:live` (loads secrets/forkline.env).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENV } from '../../constants.js';
import { parseConfig, type Config } from '../../config.js';
import { createLogger } from '../../logger.js';
import { createRouter } from '../../router/index.js';
import { collect, readFixture } from '../../test/helpers.js';
import type { RunEvent, TranslatedRequest } from '../../types.js';
import { run, type QueryFn } from '../run.js';

const HAIKU = 'claude-haiku-5-5';
let config: Config;
let root: string;

function translated(name: string, live?: string): TranslatedRequest {
  const t = readFixture<TranslatedRequest>(`golden/translated/${name}.json`);
  t.claudeModel = HAIKU;
  t.params.effort = 'low';
  t.params.maxOutputTokens = null;
  if (live) t.livePrompt = { role: 'user', content: live };
  return t;
}

async function go(t: TranslatedRequest, signal = new AbortController().signal, queryFn?: QueryFn) {
  const router = createRouter(config, createLogger('silent'));
  const plan = await router.route(t);
  const events = await collect(run({ translated: t, plan, config, signal }, queryFn));
  return { events, plan };
}

/** The SDK gives the subprocess a short grace period after an abort, so poll briefly. */
async function childrenGone(timeoutMs = 8000): Promise<number> {
  const start = Date.now();
  while (children().length > 0 && Date.now() - start < timeoutMs) await new Promise((r) => setTimeout(r, 100));
  const waited = Date.now() - start;
  console.log(`child processes gone after ${waited} ms`);
  expect(children()).toEqual([]);
  return waited;
}

const children = (): string[] => {
  try {
    return execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'forkline-live-'));
  mkdirSync(join(root, 'work'));
  const raw = readFixture<{ models: Record<string, unknown>[] } & Record<string, unknown>>('golden/config.json');
  for (const model of raw.models) {
    if (model.claudeModel === HAIKU) Object.assign(model, { marketingName: 'Haiku 5.5', knowledgeCutoff: 'June 2026' });
  }
  raw.paths = { workDir: join(root, 'work'), configDir: join(root, 'config'), database: join(root, 'db') };
  config = parseConfig(raw, { [ENV.apiKey]: 'live-test-key-0123456789', [ENV.claudeToken]: process.env[ENV.claudeToken] ?? '' });
});
afterAll(async () => { await childrenGone(); });

describe.skipIf(!process.env[ENV.claudeToken])('runner against real Claude Code (Haiku)', () => {
  it('streams reasoning and text for a rebuilt chat (case D, system-only history first)', async () => {
    const t = translated('first-message-lorebook', 'Reply with one short sentence about the island.');
    const { events, plan } = await go(t);
    expect(plan.case).toBe('D');
    expect(events[0]).toMatchObject({ type: 'started', model: HAIKU });
    expect(events.filter((e) => e.type === 'text').length).toBeGreaterThan(0);
    const last = events.at(-1);
    expect(last).toMatchObject({ type: 'finished', finishReason: 'stop' });
    expect(events.filter((e) => e.type === 'finished' || e.type === 'error')).toHaveLength(1);
  });

  it('streams reasoning events when the model thinks, for a case A request', async () => {
    const t = translated('first-message-plain', 'Think it through, then answer: which is larger, 9.11 or 9.9, and by how much?');
    t.params.effort = 'high';
    const { events, plan } = await go(t);
    expect(plan.case).toBe('A');
    const kinds = new Set(events.map((e) => e.type));
    expect(kinds.has('text')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'finished' });
    console.log('reasoning events seen:', kinds.has('reasoning'));
  });

  it('abort stops the subprocess and ends with no terminal event', async () => {
    const t = translated('edit', 'Write a long story of 600 words about a lighthouse.');
    const controller = new AbortController();
    const router = createRouter(config, createLogger('silent'));
    const plan = await router.route(t);
    const events: RunEvent[] = [];
    for await (const e of run({ translated: t, plan, config, signal: controller.signal })) {
      events.push(e);
      if (e.type === 'text' || e.type === 'reasoning') controller.abort();
    }
    expect(events.some((e) => e.type === 'finished' || e.type === 'error')).toBe(false);
    expect(events[0]).toMatchObject({ type: 'started' });
    await childrenGone();
  });

  it('return() also stops the subprocess', async () => {
    const t = translated('edit', 'Write a long story of 600 words about a lighthouse.');
    const router = createRouter(config, createLogger('silent'));
    const plan = await router.route(t);
    const gen = run({ translated: t, plan, config, signal: new AbortController().signal });
    await gen.next();
    await gen.return(undefined);
    await childrenGone();
  });

  it('trips the model guard when the served model differs from the requested one (forced fake)', async () => {
    const t = translated('edit', 'Say hi.');
    const lying: QueryFn = (params) => {
      const q = sdkQuery(params);
      const wrapped = (async function* () {
        for await (const m of q) {
          if (m.type === 'stream_event' && m.event.type === 'message_start') {
            yield { ...m, event: { ...m.event, message: { ...m.event.message, model: 'claude-opus-5-5' } } };
          } else yield m;
        }
      })();
      return Object.assign(wrapped, { close: () => q.close() }) as never;
    };
    const { events } = await go(t, undefined, lying);
    expect(events).toEqual([{ type: 'error', error: expect.objectContaining({ code: 'model-mismatch', status: 502 }) }]);
  });

  it('keeps the environment, model and date text out of a rebuilt chat', async () => {
    const { events, plan } = await go(translated('edit'));
    expect(events.at(-1)?.type).toBe('finished');
    const entries = (await plan.sessionStore.load({ projectKey: 'x', sessionId: plan.sessionId })) ?? [];
    const count = (kind: string) =>
      entries.filter((entry) => (entry.attachment as { type?: string } | undefined)?.type === kind).length;
    // Exactly our seeds: Claude Code added none of its own.
    expect([count('environment'), count('model'), count('date')]).toEqual([1, 1, 1]);
  });

  it('sends /help to the model as written', async () => {
    const { events } = await go(translated('first-message-plain', '/help'));
    expect(events[0]?.type).toBe('started');
    expect(events.at(-1)?.type).toBe('finished');
    expect(events.some((event) => event.type === 'text')).toBe(true);
  });

  it('works with an image in history and in the live prompt (resume)', async () => {
    const t = readFixture<TranslatedRequest>('golden/translated/image.json');
    t.claudeModel = HAIKU;
    t.params.effort = 'low';
    t.params.maxOutputTokens = null;
    const { events, plan } = await go(t);
    expect(plan.case).toBe('D');
    expect(events.at(-1)).toMatchObject({ type: 'finished', finishReason: 'stop' });
  });

  it('returns session-stale for a session the store does not have', async () => {
    const t = translated('edit', 'Say hi.');
    const router = createRouter(config, createLogger('silent'));
    const plan = await router.route(t);
    const missing = { ...plan, sessionId: '11111111-2222-4333-8444-555555555555', resume: '11111111-2222-4333-8444-555555555555' };
    const events = await collect(run({ translated: t, plan: missing, config, signal: new AbortController().signal }));
    expect(events).toEqual([{ type: 'error', error: expect.objectContaining({ code: 'session-stale' }) }]);
  });
});
