// STUB. Task 4 replaces this file.
import { loadConfig } from './config.js';
import { buildServer } from './http/server.js';
import { createLogger } from './logger.js';
import { createRouter } from './router/index.js';
import { run } from './runner/index.js';

const config = loadConfig();
const log = createLogger();
const router = createRouter(config, log);
const app = buildServer({ config, log, router, run });
await app.listen({ host: config.listen.host, port: config.listen.port });
log.info({ host: config.listen.host, port: config.listen.port }, 'listening');
