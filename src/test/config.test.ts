import { describe, expect, it } from 'vitest';
import { ConfigError, isAllowedListenHost, parseConfig } from '../config.js';
import { DEFAULT_SYSTEM_HEADER } from '../constants.js';
import { goldenConfig, readFixture, TEST_ENV } from './helpers.js';

const base = () => readFixture<Record<string, unknown>>('golden/config.json');

describe('config', () => {
  it('loads the golden config and applies defaults', () => {
    const config = goldenConfig();
    expect(config.systemHeader).toBe(DEFAULT_SYSTEM_HEADER);
    expect(config.adjustments).toBe('report');
    expect(config.retention).toEqual({ forkTtlMinutes: 60, headTtlDays: 7, sweepIntervalMinutes: 10 });
    expect(config.concurrency.maxActive).toBe(2);
    expect(config.timeouts).toEqual({ streamIdleMs: 90_000, deadlineMs: 600_000 });
    expect(config.limits.bodyBytes).toBe(10 * 1024 * 1024);
    expect(config.debug.captureBodies).toBe(false);
    expect(config.secrets.apiKey).toBe(TEST_ENV.FORKLINE_API_KEY);
  });

  it('expands ~ in paths', () => {
    const raw = { ...base(), paths: { workDir: '~/a', configDir: '/b' } };
    expect(parseConfig(raw, TEST_ENV).paths.workDir).not.toContain('~');
  });

  it.each([
    ['unknown key', { extra: true }],
    ['bad enum', { adjustments: 'maybe' }],
    ['default model not listed', { defaultModel: 'nope' }],
    ['no models', { models: [] }],
    ['wildcard host', { listen: { host: '0.0.0.0', port: 8800 } }],
    ['public host', { listen: { host: '8.8.8.8', port: 8800 } }],
    ['bad port', { listen: { host: '127.0.0.1', port: 70000 } }],
  ])('rejects %s', (_name, patch) => {
    expect(() => parseConfig({ ...base(), ...patch }, TEST_ENV)).toThrow(ConfigError);
  });

  it('rejects missing or short secrets', () => {
    expect(() => parseConfig(base(), {})).toThrow(/FORKLINE_API_KEY/);
    expect(() => parseConfig(base(), { ...TEST_ENV, FORKLINE_API_KEY: 'short' })).toThrow(ConfigError);
    expect(() => parseConfig(base(), { FORKLINE_API_KEY: TEST_ENV.FORKLINE_API_KEY })).toThrow(/FORKLINE_CLAUDE_TOKEN/);
  });

  it('allows only loopback and Tailscale listen hosts', () => {
    expect(isAllowedListenHost('127.0.0.1')).toBe(true);
    expect(isAllowedListenHost('100.100.100.100')).toBe(true);
    expect(isAllowedListenHost('100.63.0.1')).toBe(false);
    expect(isAllowedListenHost('100.128.0.1')).toBe(false);
    expect(isAllowedListenHost('::')).toBe(false);
  });
});
