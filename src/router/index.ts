// STUB. Task 2 replaces this with v0 (D only). Task 5 then takes it over for v1.
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { RoutePlan, Router } from '../types.js';

export function createRouter(_config: Config, _log: Logger): Router {
  return {
    async route(): Promise<RoutePlan> {
      const sessionId = randomUUID();
      return {
        case: 'D',
        sessionId,
        resume: sessionId,
        lockKey: null,
        sessionStore: { append: async () => {}, load: async () => null },
      };
    },
    async record() {},
    close() {},
  };
}
