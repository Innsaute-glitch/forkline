import { describe, expect, it } from 'vitest';
import { ENV } from '../../constants.js';
import { createLogger } from '../../logger.js';
import { createRouter } from '../../router/index.js';
import { goldenConfig, readFixture } from '../../test/helpers.js';
import type { RoutePlan, TranslatedRequest } from '../../types.js';
import { CLAUDE_ENV } from '../../constants.js';
import { buildSubprocessEnv } from '../env.js';
import { servedModelMatches } from '../guard.js';
import { buildPrompt, buildQueryOptions } from '../options.js';
import { latestRateLimits, recordRateLimit, resetRateLimits } from '../rate-limits.js';

const translated = () => readFixture<TranslatedRequest>('golden/translated/greeting-lorebook.json');
const store = { append: async () => {}, load: async () => null };
const plan = (over: Partial<RoutePlan>): RoutePlan => ({ case: 'D', sessionId: 's1', sessionStore: store, lockKey: null, ...over });

describe('servedModelMatches', () => {
  it('accepts the same id and the id plus eight digits, nothing else', () => {
    expect(servedModelMatches('claude-haiku-4-5', 'claude-haiku-4-5')).toBe(true);
    expect(servedModelMatches('claude-haiku-4-5', 'claude-haiku-4-5-20251001')).toBe(true);
    expect(servedModelMatches('claude-opus-4-1', 'claude-opus-5-5')).toBe(false);
    expect(servedModelMatches('claude-opus-4-1', '<synthetic>')).toBe(false);
    expect(servedModelMatches('claude-haiku-4-5', 'claude-haiku-4-5-2025')).toBe(false);
    expect(servedModelMatches('claude-haiku-4-5', 'claude-haiku-4-5-20251001x')).toBe(false);
    expect(servedModelMatches('claude-haiku-4-5', 'claude-haiku-4-5-latest')).toBe(false);
    expect(servedModelMatches('claude-sonnet-5', 'claude-sonnet-5-5')).toBe(false);
  });
});

describe('buildSubprocessEnv', () => {
  it('passes only the allow-list and the variables Forkline sets', () => {
    const parent = {
      PATH: '/bin', HOME: '/home/x', LANG: 'C', TZ: 'UTC',
      [ENV.apiKey]: 'secret-key', [ENV.claudeToken]: 'secret-token', FORKLINE_ANYTHING: 'x',
      ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'u', CLAUDE_CODE_USE_BEDROCK: '1', SHELL: '/bin/zsh',
    };
    const env = buildSubprocessEnv(goldenConfig(), translated(), parent);
    expect(Object.keys(env).sort()).toEqual([
      'CLAUDE_CODE_DISABLE_ATTACHMENTS', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR',
      'DISABLE_AUTOUPDATER', 'DISABLE_COMPACT', 'ENABLE_CLAUDEAI_MCP_SERVERS', 'HOME', 'LANG', 'PATH', 'TZ',
    ]);
    expect(Object.keys(env).some((k) => k.startsWith('FORKLINE_'))).toBe(false);
    expect(env[CLAUDE_ENV.oauthToken]).toBe('test-token');
    expect(env[CLAUDE_ENV.configDir]).toBe('/tmp/forkline-golden/config');
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    expect(env.DISABLE_COMPACT).toBe('1');
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('64000');
  });
  it('omits the output cap when unset and skips absent allow-list variables', () => {
    const t = translated();
    t.params.maxOutputTokens = null;
    const env = buildSubprocessEnv(goldenConfig(), t, { PATH: '/bin' });
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
    expect(env.HOME).toBeUndefined();
  });
});

describe('buildQueryOptions', () => {
  const abort = new AbortController();
  const build = (p: RoutePlan) => buildQueryOptions(translated(), p, goldenConfig(), abort, { PATH: '/bin' });

  it('passes sessionId only for A and C', () => {
    const a = build(plan({ case: 'A' }));
    expect(a.sessionId).toBe('s1');
    expect(a.resume).toBeUndefined();
    const b = build(plan({ case: 'B', resume: 's1' }));
    expect(b.resume).toBe('s1');
    expect(b.sessionId).toBeUndefined();
    const d = build(plan({ case: 'D', resume: 's1' }));
    expect(d.resume).toBe('s1');
    expect(d.sessionId).toBeUndefined();
    expect(d.forkSession).toBeUndefined();
    const c = build(plan({ case: 'C', sessionId: 'new', resume: 'src', forkSession: true, resumeSessionAt: 'cut' }));
    expect(c).toMatchObject({ resume: 'src', sessionId: 'new', forkSession: true, resumeSessionAt: 'cut' });
  });

  it('sets the fixed options and never fallbackModel', () => {
    const o = build(plan({ case: 'D', resume: 's1' }));
    expect(o).toMatchObject({
      cwd: '/tmp/forkline-golden/work', model: 'claude-sonnet-5-5', tools: [], skills: [], settingSources: [], mcpServers: {},
      strictMcpConfig: true, verbatimPrompts: true, maxTurns: 1, permissionMode: 'dontAsk', includePartialMessages: true, effort: 'medium',
      thinking: { type: 'adaptive', display: 'summarized' },
      systemPrompt: { type: 'custom', prompt: translated().systemPrompt, snapshot: false },
      abortController: abort,
    });
    expect('fallbackModel' in o).toBe(false);
    expect(o.sessionStore).toBe(store);
  });

  it('follows the configured thinking display', () => {
    const config = { ...goldenConfig(), thinkingDisplay: 'omitted' as const };
    const o = buildQueryOptions(translated(), plan({ case: 'A' }), config, abort, {});
    expect(o.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
  });

  it('throws when a resuming case has no resume id', () => {
    expect(() => build(plan({ case: 'D' }))).toThrow();
  });

  it('uses a string prompt for text and a one-message iterable for array content', async () => {
    expect(buildPrompt({ role: 'user', content: 'hi' })).toBe('hi');
    const prompt = buildPrompt({ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'data:image/gif;base64,QQ==' } }] });
    const messages = [];
    for await (const m of prompt as AsyncIterable<unknown>) messages.push(m);
    expect(messages).toEqual([{
      type: 'user', parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: 'QQ==' } }] },
    }]);
  });

  it('builds options for every golden case through the router', async () => {
    const t = readFixture<TranslatedRequest>('golden/translated/image.json');
    const p = await createRouter(goldenConfig(), createLogger('silent')).route(t);
    const o = buildQueryOptions(t, p, goldenConfig(), abort, {});
    expect(p.case === 'A' ? o.sessionId : o.resume).toBe(p.sessionId);
  });
});

describe('rate limit snapshot', () => {
  it('is null until an event arrives, then keeps the newest value per window', () => {
    resetRateLimits();
    expect(latestRateLimits()).toBeNull();
    recordRateLimit({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5, resetsAt: 100 }, new Date('2026-11-04T00:00:00Z'));
    recordRateLimit({ status: 'allowed_warning', rateLimitType: 'seven_day', resetsAt: 200 }, new Date('2026-11-04T00:00:01Z'));
    expect(latestRateLimits()).toEqual({
      five_hour: { status: 'allowed', utilization: 0.5, resetsAt: 100, updatedAt: '2026-11-04T00:00:00.000Z' },
      seven_day: { status: 'allowed_warning', utilization: null, resetsAt: 200, updatedAt: '2026-11-04T00:00:01.000Z' },
    });
  });
  it('reads every window from unifiedWindows when present', () => {
    resetRateLimits();
    recordRateLimit({
      status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1,
      unifiedWindows: { five_hour: { utilization: 0.78, resetsAt: 1, status: 'allowed' }, seven_day: { utilization: 0.34, resetsAt: 2, status: 'allowed' } },
    } as never);
    expect(latestRateLimits()?.five_hour?.utilization).toBe(0.78);
    expect(latestRateLimits()?.seven_day?.utilization).toBe(0.34);
    resetRateLimits();
  });
  it('returns a copy', () => {
    resetRateLimits();
    recordRateLimit({ status: 'allowed', rateLimitType: 'five_hour' });
    latestRateLimits()!.five_hour!.status = 'rejected';
    expect(latestRateLimits()?.five_hour?.status).toBe('allowed');
    resetRateLimits();
  });
});
