// POST /v1/chat/completions: the request flow of plan.md section 3.1, steps 1 to 8.
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { ADJUSTMENT_HEADER } from '../constants.js';
import { bridgeError, toErrorBody } from '../errors.js';
import type { Logger, RequestLogFields } from '../logger.js';
import type { RunFn } from '../runner/index.js';
import { toCompletion, toSse } from '../stream/index.js';
import { translate } from '../translator/index.js';
import type {
  BridgeErrorInfo,
  ChatRequest,
  RoutePlan,
  Router,
  RunEvent,
  StreamContext,
  StreamResult,
  TranslatedRequest,
} from '../types.js';
import { prepend } from './first-event.js';
import type { Limiter } from './limiter.js';

export const CHAT_PATH = '/v1/chat/completions';

/** Logged as `errorCode` when the client left before a full reply. Not a client-visible error. */
export const CLIENT_DISCONNECTED = 'client-disconnected';
/** Logged as `status` when the client left and nothing was sent (nginx convention). */
const STATUS_CLIENT_CLOSED = 499;

export interface ChatDeps {
  config: Config;
  log: Logger;
  router: Router;
  run: RunFn;
  limiter: Limiter;
  /** One controller per running request; the server aborts these on shutdown. */
  inflight: Set<AbortController>;
}

type RunGenerator = AsyncGenerator<RunEvent>;

/** Logged as `errorCode` when shutdown ended the run. Not a client-visible error. */
export const SERVER_SHUTDOWN = 'server-shutdown';
const STATUS_SERVER_STOPPING = 503;

/**
 * The adjustments header value. Names can hold a client's field name, which may not be legal in a
 * header, and writing an illegal value throws after the run has started.
 */
export function adjustmentsHeader(adjustments: string[]): string {
  return adjustments.map((name) => name.replace(/[^\x21-\x2b\x2d-\x7e]/g, '?')).join(',');
}

/** Resolves on drain, or on close so a vanished client cannot hang the loop. */
function drained(res: FastifyReply['raw']): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

export function createChatHandler(deps: ChatDeps) {
  const { config, log, router, run, limiter, inflight } = deps;

  return async function chat(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);
    const requestId = randomUUID();
    const raw = reply.raw;
    const body = request.body;
    const bodyRecord =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;

    const rec: RequestLogFields = {
      requestId,
      route: CHAT_PATH,
      model: typeof bodyRecord?.model === 'string' ? bodyRecord.model.slice(0, 100) : '',
      stream: bodyRecord?.stream === true,
      routeCase: null,
      status: 0,
      adjustments: [],
      durationMs: 0,
      firstByteMs: null,
      usage: null,
      errorCode: null,
    };

    const ctl = new AbortController();
    inflight.add(ctl);
    let clientGone = false;
    const onClose = () => {
      if (!raw.writableFinished) {
        clientGone = true;
        ctl.abort();
      }
    };
    raw.on('close', onClose);

    let slot = null as { release: () => void } | null;
    let lock = null as { key: string; release: () => void } | null;
    /** True once the response was sent, or taken over with hijack(). */
    let taken = false;
    let adjustmentsValue: string | null = null;
    let gen: RunGenerator | undefined;
    let stopMatched = false;

    // ---- response helpers (each records status, error code and first-byte time) ----

    const sendError = (info: BridgeErrorInfo): FastifyReply => {
      taken = true;
      rec.status = info.status;
      rec.errorCode = info.code;
      rec.firstByteMs ??= elapsed();
      if (info.retryAfterSeconds !== undefined) {
        reply.header('Retry-After', String(info.retryAfterSeconds));
      }
      return reply.status(info.status).send(toErrorBody(info));
    };

    /** The client is gone (or the server is stopping): send nothing at all. */
    const sendNothing = (): FastifyReply => {
      if (!taken) {
        taken = true;
        reply.hijack();
      }
      if (rec.status === 0) rec.status = clientGone ? STATUS_CLIENT_CLOSED : STATUS_SERVER_STOPPING;
      rec.errorCode ??= clientGone ? CLIENT_DISCONNECTED : SERVER_SHUTDOWN;
      if (!raw.writableEnded) raw.destroy();
      return reply;
    };

    const startRun = (translated: TranslatedRequest, plan: RoutePlan): RunGenerator =>
      run({ translated, plan, config, signal: ctl.signal });

    /** Releases the held lock unless `key` is the one held, then takes `key` if not null. */
    const swapLock = async (key: string | null): Promise<{ ok: boolean; waited: boolean }> => {
      if (lock?.key === key) return { ok: true, waited: false };
      lock?.release();
      lock = null;
      if (key === null) return { ok: true, waited: false };
      const got = await limiter.acquireLock(key, ctl.signal);
      if (!got.ok) return { ok: false, waited: false };
      lock = { key, release: got.release };
      return { ok: true, waited: got.waited };
    };

    const recordUsage = (result: StreamResult | null) => {
      if (!result) return;
      if (result.usage) {
        rec.usage = {
          input: result.usage.inputTokens,
          output: result.usage.outputTokens,
          cacheRead: result.usage.cacheReadTokens,
          cacheWrite: result.usage.cacheWriteTokens,
        };
      }
      if (result.error) rec.errorCode ??= result.error.code;
    };

    /** Step 7. Never changes the response; a failure is only logged. */
    const maybeRecord = async (
      translated: TranslatedRequest,
      plan: RoutePlan,
      result: StreamResult | null,
      clientStayed: boolean,
    ) => {
      if (!result || !clientStayed) return;
      if (result.finishReason !== 'stop' || result.stopMatched || result.error) return;
      try {
        await router.record({ translated, plan, replyText: result.replyText });
      } catch (err) {
        log.warn(
          { requestId, error: err instanceof Error ? err.message : 'unknown' },
          'record failed',
        );
      }
    };

    try {
      // ---- Step 1: translate ----
      if (config.debug.captureBodies) log.info({ requestId, body }, 'request body');
      if (!bodyRecord) {
        return sendError(bridgeError('invalid-request', 'request body must be a JSON object'));
      }
      const translation = translate(bodyRecord as ChatRequest, config);
      if (!translation.ok) return sendError(translation.error);
      const translated = translation.value;
      rec.model = translated.claudeModel;
      rec.stream = translated.params.stream;
      rec.adjustments = translated.adjustments;
      adjustmentsValue = adjustmentsHeader(translated.adjustments);
      reply.header(ADJUSTMENT_HEADER, adjustmentsValue);

      // ---- Step 2: slot ----
      const gotSlot = await limiter.acquireSlot(ctl.signal);
      if (!gotSlot.ok) {
        return gotSlot.reason === 'queue-full' ? sendError(gotSlot.error) : sendNothing();
      }
      slot = gotSlot;
      if (clientGone) return sendNothing();

      // ---- Step 3: route ----
      let plan = await router.route(translated);
      rec.routeCase = plan.case;
      if (clientGone) return sendNothing();

      // ---- Step 4: lock; after a wait, route again once ----
      const firstLock = await swapLock(plan.lockKey);
      if (!firstLock.ok) return sendNothing();
      if (firstLock.waited) {
        plan = await router.route(translated);
        rec.routeCase = plan.case;
        if (!(await swapLock(plan.lockKey)).ok) return sendNothing();
      }
      if (clientGone) return sendNothing();

      // ---- Step 5: run, and look at the first event before sending anything ----
      gen = startRun(translated, plan);
      let first = await gen.next();
      if (!first.done && first.value.type === 'error' && first.value.error.code === 'session-stale') {
        await gen.return(undefined);
        plan = await router.route(translated, { forceRebuild: true });
        rec.routeCase = plan.case;
        if (!(await swapLock(plan.lockKey)).ok) return sendNothing();
        if (clientGone) return sendNothing();
        gen = startRun(translated, plan);
        first = await gen.next();
      }

      if (first.done) {
        // No event at all: an abort (nothing to say), or a runner bug.
        if (clientGone || ctl.signal.aborted) return sendNothing();
        return sendError(bridgeError('upstream', 'the run ended without any event'));
      }
      const head = first.value;
      if (head.type === 'error') {
        await gen.return(undefined);
        return sendError(head.error);
      }
      if (head.type !== 'started') {
        await gen.return(undefined);
        return sendError(bridgeError('upstream', 'the run did not start with a started event'));
      }

      const done: { result: StreamResult | null } = { result: null };
      const ctxFor = (): StreamContext => ({
        id: `chatcmpl-${randomUUID()}`,
        created: Math.floor(Date.now() / 1000),
        model: translated.responseModel,
        stop: translated.params.stop,
        includeUsage: translated.params.includeUsage,
        onStopMatched: () => {
          stopMatched = true;
          ctl.abort();
        },
        onDone: (r) => {
          done.result = r;
        },
      });
      const events = prepend<RunEvent>(head, gen as RunGenerator);

      if (translated.params.stream) {
        // ---- Streaming: send 200 now ----
        taken = true;
        reply.hijack();
        raw.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          [ADJUSTMENT_HEADER]: adjustmentsValue,
        });
        raw.flushHeaders();
        rec.status = 200;
        try {
          for await (const frame of toSse(events, ctxFor())) {
            if (clientGone || raw.destroyed) break;
            rec.firstByteMs ??= elapsed();
            if (!raw.write(frame)) await drained(raw);
          }
        } finally {
          // Captured before end(): a client closing right after [DONE] still counts as connected.
          const clientStayed = !clientGone;
          if (!raw.destroyed && !raw.writableEnded) raw.end();
          if (clientGone) rec.errorCode ??= CLIENT_DISCONNECTED;
          else if (ctl.signal.aborted && !stopMatched) rec.errorCode ??= SERVER_SHUTDOWN;
          recordUsage(done.result);
          await maybeRecord(translated, plan, done.result, clientStayed);
        }
        return reply;
      }

      // ---- Non-streaming: nothing is sent until toCompletion returns ----
      const completion = await toCompletion(events, ctxFor());
      const clientStayed = !clientGone;
      recordUsage(done.result);
      if (clientGone) return sendNothing();
      if (!completion.ok) return sendError(completion.error);
      taken = true;
      rec.status = 200;
      rec.firstByteMs ??= elapsed();
      const sent = reply.status(200).send(completion.body);
      await maybeRecord(translated, plan, done.result, clientStayed);
      return sent;
    } catch (err) {
      log.error({ requestId, err }, 'chat request failed');
      rec.errorCode ??= 'upstream';
      // Nothing else will end the run, and its subprocess, on this path.
      ctl.abort();
      await gen?.return(undefined).catch(() => undefined);
      if (!taken) return sendError(bridgeError('upstream', 'internal error'));
      if (!raw.writableEnded) raw.destroy();
      return reply;
    } finally {
      lock?.release();
      slot?.release();
      raw.off('close', onClose);
      inflight.delete(ctl);
      rec.durationMs = elapsed();
      log.info(rec, 'request');
    }
  };
}
