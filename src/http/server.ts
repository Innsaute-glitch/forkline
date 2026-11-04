import { setTimeout as sleep } from 'node:timers/promises';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { Config } from '../config.js';
import { SDK_VERSION } from '../constants.js';
import { bridgeError, toErrorBody } from '../errors.js';
import type { Logger, RequestLogFields } from '../logger.js';
import { latestRateLimits, type RunFn } from '../runner/index.js';
import type { BridgeErrorInfo, Router } from '../types.js';
import { bearerMatches } from './auth.js';
import { CHAT_PATH, createChatHandler } from './chat.js';
import { createLimiter } from './limiter.js';

export interface ServerDeps {
  config: Config;
  log: Logger;
  router: Router;
  /** Injected so tests can use a fake run. */
  run: RunFn;
  /** Test hook: overrides SHUTDOWN_GRACE_MS. */
  shutdownGraceMs?: number;
}

/** On shutdown, in-flight requests get this long to finish before their runs are aborted. */
export const SHUTDOWN_GRACE_MS = 10_000;

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { config, log, router, run, shutdownGraceMs = SHUTDOWN_GRACE_MS } = deps;
  const app = Fastify({ bodyLimit: config.limits.bodyBytes, logger: false });
  const limiter = createLimiter(config.concurrency);
  const inflight = new Set<AbortController>();

  const sendError = (reply: FastifyReply, info: BridgeErrorInfo): FastifyReply => {
    if (info.retryAfterSeconds !== undefined) {
      reply.header('Retry-After', String(info.retryAfterSeconds));
    }
    return reply.status(info.status).send(toErrorBody(info));
  };

  // Every route, including unknown ones, needs the key.
  app.addHook('onRequest', async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, config.secrets.apiKey)) {
      log.warn({ method: request.method, route: request.url.split('?')[0] }, 'unauthorized');
      reply.header('WWW-Authenticate', 'Bearer');
      return sendError(reply, bridgeError('unauthorized', 'missing or invalid API key'));
    }
    return undefined;
  });

  app.setNotFoundHandler((request, reply) =>
    sendError(reply, bridgeError('not-found', `no route for ${request.method} ${request.url.split('?')[0]}`)),
  );

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const status = error.statusCode ?? 500;
    const info =
      status === 413
        ? bridgeError('body-too-large', 'request body is too large')
        : status >= 400 && status < 500
          ? bridgeError('invalid-request', error.message)
          : bridgeError('upstream', 'internal error');
    if (status >= 500) log.error({ err: error }, 'unhandled error');
    // A body that failed to parse never reached the chat handler: still one request line.
    if (request.method === 'POST' && request.url.split('?')[0] === CHAT_PATH) {
      const fields: RequestLogFields = {
        requestId: request.id,
        route: CHAT_PATH,
        model: '',
        stream: false,
        routeCase: null,
        status: info.status,
        adjustments: [],
        durationMs: Math.round(reply.elapsedTime),
        firstByteMs: null,
        usage: null,
        errorCode: info.code,
      };
      log.info(fields, 'request');
    }
    return sendError(reply, info);
  });

  app.get('/v1/models', async () => ({
    object: 'list',
    data: config.models.map((model) => ({
      id: model.id,
      object: 'model',
      created: 0,
      owned_by: 'forkline',
    })),
  }));

  app.get('/health', async () => {
    const { active, queued } = limiter.stats();
    return {
      status: 'ok',
      engine: { sdk: SDK_VERSION },
      active,
      queued,
      rateLimits: latestRateLimits(),
    };
  });

  app.post(CHAT_PATH, createChatHandler({ config, log, router, run, limiter, inflight }));

  // Shutdown: let running requests finish for a while, then abort what is left.
  app.addHook('preClose', async () => {
    const deadline = Date.now() + shutdownGraceMs;
    while (inflight.size > 0 && Date.now() < deadline) await sleep(50);
    for (const controller of inflight) controller.abort();
    for (let i = 0; i < 100 && inflight.size > 0; i += 1) await sleep(50);
  });
  app.addHook('onClose', async () => {
    router.close();
  });

  return app;
}
