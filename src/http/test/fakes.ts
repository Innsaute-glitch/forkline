// Test fakes for the HTTP layer: stream mapper, run, router, logger. Test code only.
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { parseConfig, type Config } from '../../config.js';
import { toErrorBody } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { pino } from 'pino';
import type { RunFn, RunInput } from '../../runner/index.js';
import { readFixture, TEST_ENV } from '../../test/helpers.js';
import type {
  ChatCompletion,
  CompletionResult,
  RoutePlan,
  Router,
  RunEvent,
  StreamContext,
  StreamResult,
  TranslatedRequest,
} from '../../types.js';

export const API_KEY = TEST_ENV.FORKLINE_API_KEY;
export const AUTH = { authorization: `Bearer ${API_KEY}` };
/** Sentinel placed in message content: it must never appear in any log line. */
export const CONTENT_SENTINEL = 'zq-secret-roleplay-content';

export const events = (name: string): RunEvent[] => readFixture<RunEvent[]>(`run-events/${name}.json`);

export function makeConfig(overrides: Record<string, unknown> = {}): Config {
  const raw = readFixture<Record<string, unknown>>('golden/config.json');
  return parseConfig({ ...raw, ...overrides }, TEST_ENV);
}

export function translatedFixture(overrides: Partial<TranslatedRequest> = {}): TranslatedRequest {
  const base = readFixture<TranslatedRequest>('golden/translated/greeting-lorebook.json');
  return { ...base, ...overrides };
}

// ---- stream mapper fakes (they follow the contract, not the real format) ----

export const streamCalls = { toSse: 0, toCompletion: 0 };

function summarize(): { result: StreamResult; absorb: (e: RunEvent, ctx: StreamContext) => boolean } {
  const result: StreamResult = {
    replyText: '',
    reasoningText: '',
    stopMatched: false,
    finishReason: null,
    usage: null,
    error: null,
  };
  const absorb = (e: RunEvent, ctx: StreamContext): boolean => {
    if (e.type === 'text') {
      result.replyText += e.text;
      const hit = ctx.stop.find((s) => result.replyText.includes(s));
      if (hit) {
        result.replyText = result.replyText.slice(0, result.replyText.indexOf(hit));
        result.stopMatched = true;
        result.finishReason = 'stop';
        ctx.onStopMatched();
        return true;
      }
    } else if (e.type === 'reasoning') result.reasoningText += e.text;
    else if (e.type === 'finished') {
      result.finishReason = e.finishReason;
      result.usage = e.usage;
    } else if (e.type === 'error') result.error = e.error;
    return false;
  };
  return { result, absorb };
}

export async function* fakeToSse(
  eventsIn: AsyncIterable<RunEvent>,
  ctx: StreamContext,
): AsyncGenerator<string> {
  streamCalls.toSse += 1;
  const { result, absorb } = summarize();
  let done = false;
  try {
    for await (const e of eventsIn) {
      const stop = absorb(e, ctx);
      if (e.type === 'error') yield `data: ${JSON.stringify(toErrorBody(e.error))}\n\n`;
      else if (e.type === 'text' || e.type === 'reasoning') yield `data: ${JSON.stringify({ t: e.text })}\n\n`;
      else yield `data: ${JSON.stringify({ e: e.type })}\n\n`;
      if (stop) break;
    }
    yield 'data: [DONE]\n\n';
  } finally {
    if (!done) {
      done = true;
      ctx.onDone(result);
    }
  }
}

export async function fakeToCompletion(
  eventsIn: AsyncIterable<RunEvent>,
  ctx: StreamContext,
): Promise<CompletionResult> {
  streamCalls.toCompletion += 1;
  const { result, absorb } = summarize();
  for await (const e of eventsIn) {
    if (absorb(e, ctx)) break;
  }
  ctx.onDone(result);
  if (result.error) return { ok: false, error: result.error };
  if (result.finishReason === null) {
    return { ok: false, error: { code: 'upstream', status: 502, message: 'no terminal event' } };
  }
  const body: ChatCompletion = {
    id: ctx.id,
    object: 'chat.completion',
    created: ctx.created,
    model: ctx.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.replyText },
        finish_reason: result.finishReason,
      },
    ],
  };
  return { ok: true, body };
}

// ---- run fake ----

export interface RunState {
  inputs: RunInput[];
  /** Number of runs whose generator reached its `finally` (completed or returned). */
  ended: number;
}

export interface ReplayOptions {
  /** Wait for this promise before yielding the event at index `gateAt` (or abort). */
  gate?: { promise: Promise<void> };
  gateAt?: number;
}

function onAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** Replays events, stops without a terminal event when the signal aborts. */
export function replay(items: RunEvent[], options: ReplayOptions = {}, state?: RunState): RunFn {
  return (input: RunInput) => {
    state?.inputs.push(input);
    return (async function* () {
      try {
        for (let i = 0; i < items.length; i += 1) {
          if (options.gate && i === (options.gateAt ?? 0)) {
            await Promise.race([options.gate.promise, onAbort(input.signal)]);
          }
          if (input.signal.aborted) return;
          yield items[i] as RunEvent;
        }
      } finally {
        if (state) state.ended += 1;
      }
    })();
  };
}

export const newRunState = (): RunState => ({ inputs: [], ended: 0 });

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---- router fake ----

export interface FakeRouter extends Router {
  route: ReturnType<typeof vi.fn<Router['route']>>;
  record: ReturnType<typeof vi.fn<Router['record']>>;
  close: ReturnType<typeof vi.fn<Router['close']>>;
}

export function planFor(lockKey: string | null = null, sessionId: string = randomUUID()): RoutePlan {
  return {
    case: 'D',
    sessionId,
    resume: sessionId,
    lockKey,
    sessionStore: { append: async () => {}, load: async () => null },
  };
}

export function fakeRouter(route?: Router['route']): FakeRouter {
  return {
    route: vi.fn<Router['route']>(route ?? (async () => planFor())),
    record: vi.fn<Router['record']>(async () => {}),
    close: vi.fn<Router['close']>(() => {}),
  };
}

// ---- logger that keeps its lines ----

export function captureLog(): { log: Logger; lines: Record<string, unknown>[]; requests: () => Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const log = pino(
    { level: 'debug' },
    { write: (chunk: string) => void lines.push(JSON.parse(chunk) as Record<string, unknown>) },
  );
  return { log, lines, requests: () => lines.filter((l) => l.msg === 'request') };
}
