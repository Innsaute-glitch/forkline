// Builds a server around the fakes. Importers must call vi.mock for the translator,
// stream and runner modules (see the top of each test file).
import type { FastifyInstance } from 'fastify';
import { vi } from 'vitest';
import type { Config } from '../../config.js';
import { bridgeError } from '../../errors.js';
import type { RunFn } from '../../runner/index.js';
import { translate } from '../../translator/index.js';
import type { ChatRequest, TranslateResult } from '../../types.js';
import { buildServer } from '../server.js';
import {
  AUTH,
  captureLog,
  CONTENT_SENTINEL,
  events,
  fakeRouter,
  makeConfig,
  replay,
  translatedFixture,
  type FakeRouter,
} from './fakes.js';

export const CHAT = '/v1/chat/completions';

/** Request fields the translate mock understands (not part of any real request). */
export interface TestBody extends ChatRequest {
  _fail?: boolean;
  _stop?: string[];
  _adjustments?: string[];
}

export function installTranslate(): void {
  vi.mocked(translate).mockImplementation((request): TranslateResult => {
    const body = request as TestBody;
    if (body._fail) return { ok: false, error: bridgeError('invalid-request', 'bad request') };
    const base = translatedFixture();
    return {
      ok: true,
      value: {
        ...base,
        responseModel: typeof body.model === 'string' ? body.model : base.responseModel,
        params: {
          ...base.params,
          stream: body.stream === true,
          stop: body._stop ?? [],
        },
        adjustments: body._adjustments ?? base.adjustments,
      },
    };
  });
}

export interface AppOptions {
  run?: RunFn;
  router?: FakeRouter;
  config?: Config;
  shutdownGraceMs?: number;
}

export function makeApp(options: AppOptions = {}) {
  const cap = captureLog();
  const router = options.router ?? fakeRouter();
  const config = options.config ?? makeConfig();
  const app: FastifyInstance = buildServer({
    config,
    log: cap.log,
    router,
    run: options.run ?? replay(events('plain-text')),
    ...(options.shutdownGraceMs !== undefined ? { shutdownGraceMs: options.shutdownGraceMs } : {}),
  });
  return { app, router, config, ...cap };
}

export const chatBody = (extra: Partial<TestBody> = {}): TestBody => ({
  model: 'm',
  messages: [{ role: 'user', content: CONTENT_SENTINEL }],
  ...extra,
});

export const postChat = (app: FastifyInstance, body: unknown, headers: Record<string, string> = AUTH) =>
  app.inject({
    method: 'POST',
    url: CHAT,
    headers: { ...headers, 'content-type': 'application/json' },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });

export const health = async (app: FastifyInstance) =>
  (await app.inject({ method: 'GET', url: '/health', headers: AUTH })).json() as {
    active: number;
    queued: number;
  };
