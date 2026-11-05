// Router: case A when history is empty, otherwise case D. Forkline keeps no sessions.
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { release, type } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { buildEntries, buildSeedEntries, type SeedFacts } from '../transcript/index.js';
import type { RoutePlan, Router, TranslatedRequest } from '../types.js';
import { MemorySessionStore } from './memory-store.js';

/** Adapters key on sessionId only; the SDK derives the real projectKey itself. */
const PROJECT_KEY = '';

const pad = (value: number): string => String(value).padStart(2, '0');

/** The local date, which is what Claude Code uses. */
function localDate(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function realWorkDir(workDir: string): string {
  try {
    return realpathSync(workDir);
  } catch {
    return workDir;
  }
}

/**
 * The env allow-list withholds SHELL, so Claude Code picks one itself: zsh if it is anywhere on
 * PATH, otherwise bash.
 */
export function detectShell(path = process.env.PATH ?? ''): string {
  return path.split(delimiter).some((dir) => dir && existsSync(join(dir, 'zsh'))) ? 'zsh' : 'bash';
}

function seedFacts(config: Config, claudeModel: string): SeedFacts {
  const model = config.models.find((candidate) => candidate.claudeModel === claudeModel);
  return {
    workDir: realWorkDir(config.paths.workDir),
    platform: process.platform,
    shell: detectShell(),
    osVersion: `${type()} ${release()}`,
    today: localDate(new Date()),
    identity:
      model?.marketingName && model.knowledgeCutoff
        ? { modelId: claudeModel, marketingName: model.marketingName, knowledgeCutoff: model.knowledgeCutoff }
        : null,
  };
}

export function createRouter(config: Config, _log: Logger): Router {
  return {
    async route(translated: TranslatedRequest): Promise<RoutePlan> {
      const sessionId = randomUUID();
      const sessionStore = new MemorySessionStore();
      if (translated.history.length === 0) {
        return { case: 'A', sessionId, sessionStore, lockKey: null };
      }
      const ctx = {
        sessionId,
        model: translated.claudeModel,
        newUuid: randomUUID,
        now: () => new Date().toISOString(),
      };
      const entries = buildEntries(translated.history, ctx);
      const seeds = buildSeedEntries(
        entries.at(-1)?.uuid ?? null,
        seedFacts(config, translated.claudeModel),
        ctx,
      );
      await sessionStore.append({ projectKey: PROJECT_KEY, sessionId }, [...entries, ...seeds]);
      return { case: 'D', sessionId, sessionStore, resume: sessionId, lockKey: null };
    },
    async record() {},
    close() {},
  };
}
