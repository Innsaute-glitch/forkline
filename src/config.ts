import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { DEFAULT_CONFIG_PATH, DEFAULT_SYSTEM_HEADER, ENV } from './constants.js';

const effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const positiveInt = z.number().int().positive();

/** Loopback or Tailscale CGNAT (100.64.0.0/10). Never a wildcard or public address. */
export function isAllowedListenHost(host: string): boolean {
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  const match = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const [second, third, fourth] = match.slice(1).map(Number) as [number, number, number];
  return second >= 64 && second <= 127 && third <= 255 && fourth <= 255;
}

const fileSchema = z
  .strictObject({
    listen: z.strictObject({
      host: z.string().refine(isAllowedListenHost, {
        message: 'listen.host must be loopback or a Tailscale address',
      }),
      port: positiveInt.max(65535),
    }),
    models: z
      .array(
        z.strictObject({
          id: z.string().min(1),
          claudeModel: z.string().min(1),
          /** Model's output ceiling, used to report max-tokens-capped. */
          maxOutputTokens: positiveInt.optional(),
          /**
           * Claude Code's own name and cutoff for this model. Both must match exactly for its
           * model line to be replaced; without them that line stays in the request.
           */
          marketingName: z.string().min(1).optional(),
          /** Claude Code folds system entries into the user message for this model. */
          foldsSystemMessages: z.boolean().optional(),
          knowledgeCutoff: z.string().min(1).optional(),
        }),
      )
      .min(1),
    defaultModel: z.string().min(1),
    systemHeader: z.string().default(DEFAULT_SYSTEM_HEADER),
    thinkingDisplay: z.enum(['summarized', 'omitted']).default('summarized'),
    defaultEffort: effort.default('medium'),
    adjustments: z.enum(['report', 'reject']).default('report'),
    retention: z
      .strictObject({
        forkTtlMinutes: positiveInt.default(60),
        headTtlDays: positiveInt.default(7),
        sweepIntervalMinutes: positiveInt.default(10),
      })
      .prefault({}),
    concurrency: z
      .strictObject({
        maxActive: positiveInt.default(2),
        maxQueued: z.number().int().nonnegative().default(4),
        queueTimeoutMs: positiveInt.default(15_000),
      })
      .prefault({}),
    paths: z.strictObject({
      workDir: z.string().min(1),
      configDir: z.string().min(1),
    }),
    timeouts: z
      .strictObject({
        streamIdleMs: positiveInt.default(90_000),
        deadlineMs: positiveInt.default(600_000),
      })
      .prefault({}),
    limits: z.strictObject({ bodyBytes: positiveInt.default(10 * 1024 * 1024) }).prefault({}),
    debug: z.strictObject({ captureBodies: z.boolean().default(false) }).prefault({}),
  })
  .superRefine((config, ctx) => {
    const ids = config.models.map((model) => model.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', path: ['models'], message: 'model ids must be unique' });
    }
    if (!ids.includes(config.defaultModel)) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaultModel'],
        message: 'defaultModel must be one of the configured model ids',
      });
    }
  });

export type FileConfig = z.infer<typeof fileSchema>;

export interface Secrets {
  apiKey: string;
  claudeToken: string;
}

export type Config = FileConfig & { secrets: Secrets };

export class ConfigError extends Error {
  override name = 'ConfigError';
}

function expandPath(path: string, baseDir: string): string {
  if (path === '~' || path.startsWith('~/')) return join(homedir(), path.slice(1));
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

/** Validates a parsed config object plus secrets. Throws ConfigError with every problem listed. */
export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv, baseDir = process.cwd()): Config {
  const parsed = fileSchema.safeParse(raw);
  const problems = parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);

  const apiKey = env[ENV.apiKey] ?? '';
  const claudeToken = env[ENV.claudeToken] ?? '';
  if (apiKey.length < 16) problems.push(`${ENV.apiKey} must be set, at least 16 characters`);
  if (!claudeToken) problems.push(`${ENV.claudeToken} must be set`);

  if (!parsed.success || problems.length > 0) {
    throw new ConfigError(`Invalid config:\n- ${problems.join('\n- ')}`);
  }

  const { paths } = parsed.data;
  return {
    ...parsed.data,
    paths: {
      workDir: expandPath(paths.workDir, baseDir),
      configDir: expandPath(paths.configDir, baseDir),
    },
    secrets: { apiKey, claudeToken },
  };
}

/** Reads the file named by FORKLINE_CONFIG, or the dev config. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const path = env[ENV.configPath] ?? DEFAULT_CONFIG_PATH;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new ConfigError(`Cannot read config ${path}: ${(cause as Error).message}`);
  }
  return parseConfig(raw, env);
}
