import { mkdirSync, realpathSync } from 'node:fs';
import { ConfigError, loadConfig } from './config.js';
import { buildServer } from './http/server.js';
import { createLogger } from './logger.js';
import { createRouter } from './router/index.js';
import { run } from './runner/index.js';
import { removeAllLocalTranscripts, removeStaleResumeFolders } from './runner/local-transcript.js';

const log = createLogger();

let config;
try {
  config = loadConfig();
} catch (error) {
  // ConfigError lists every problem and never includes secret values.
  if (error instanceof ConfigError) {
    log.fatal(error.message);
    process.exit(1);
  }
  throw error;
}

// The Claude Code subprocess runs in workDir with configDir as its CLAUDE_CONFIG_DIR.
mkdirSync(config.paths.workDir, { recursive: true, mode: 0o700 });
mkdirSync(config.paths.configDir, { recursive: true, mode: 0o700 });
// Anything left here came from a crash; nothing is running yet.
removeAllLocalTranscripts(config.paths.configDir);
removeStaleResumeFolders(realpathSync(config.paths.workDir));

const router = createRouter(config, log);
const app = buildServer({ config, log, router, run });

let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  app.close().then(
    () => process.exit(0),
    (error: unknown) => {
      log.error({ err: error }, 'shutdown failed');
      process.exit(1);
    },
  );
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

try {
  await app.listen({ host: config.listen.host, port: config.listen.port });
} catch (error) {
  log.fatal({ err: error }, 'cannot listen');
  router.close();
  process.exit(1);
}
log.info({ host: config.listen.host, port: config.listen.port }, 'listening');
