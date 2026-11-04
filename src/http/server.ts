// STUB. Task 4 replaces this file.
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { RunFn } from '../runner/index.js';
import type { Router } from '../types.js';

export interface ServerDeps {
  config: Config;
  log: Logger;
  router: Router;
  /** Injected so tests can use a fake run. */
  run: RunFn;
}

export function buildServer(_deps: ServerDeps): FastifyInstance {
  const app = Fastify();
  app.get('/health', async () => ({ status: 'stub' }));
  return app;
}
