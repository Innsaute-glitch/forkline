// Router v0: case A when history is empty, otherwise case D. Task 5 takes this over for v1.
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { buildEntries } from '../transcript/index.js';
import type { RoutePlan, Router, TranslatedRequest } from '../types.js';
import { MemorySessionStore } from './memory-store.js';

/** Adapters key on sessionId only; the SDK derives the real projectKey itself. */
const PROJECT_KEY = '';

export function createRouter(_config: Config, _log: Logger): Router {
  return {
    async route(translated: TranslatedRequest): Promise<RoutePlan> {
      const sessionId = randomUUID();
      const sessionStore = new MemorySessionStore();
      if (translated.history.length === 0) {
        return { case: 'A', sessionId, sessionStore, lockKey: null };
      }
      const entries = buildEntries(translated.history, {
        sessionId,
        model: translated.claudeModel,
        newUuid: randomUUID,
        now: () => new Date().toISOString(),
      });
      await sessionStore.append({ projectKey: PROJECT_KEY, sessionId }, entries);
      return { case: 'D', sessionId, sessionStore, resume: sessionId, lockKey: null };
    },
    async record() {},
    close() {},
  };
}
