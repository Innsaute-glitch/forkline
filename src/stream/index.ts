// Stream mapper: RunEvent -> OpenAI SSE frames or one chat.completion. No I/O.
import { SSE_DONE } from '../constants.js';
import { bridgeError } from '../errors.js';
import type {
  BridgeErrorInfo,
  ChatCompletion,
  CompletionResult,
  FinishReason,
  RunEvent,
  StreamContext,
  StreamResult,
  TokenUsage,
} from '../types.js';
import { StopScanner } from './stop-scanner.js';
import {
  errorFrame,
  finalFrame,
  headFrame,
  reasoningFrame,
  textFrame,
  toWireUsage,
  usageFrame,
} from './wire.js';

type Outcome =
  | {
      kind: 'finished';
      finishReason: FinishReason;
      usage: TokenUsage | null;
      stopMatched: boolean;
    }
  | { kind: 'error'; error: BridgeErrorInfo; stopMatched: boolean }
  /** The events ended with no terminal event, or the consumer closed early. */
  | { kind: 'aborted' };

type Piece =
  | { type: 'head' }
  | { type: 'reasoning'; text: string }
  | { type: 'text'; text: string }
  | { type: 'end'; outcome: Outcome };

interface Accumulated {
  replyText: string;
  reasoningText: string;
}

/**
 * Walks the events once. Applies the stop scanner to `text`, calls
 * `onStopMatched` and `onDone` (each at most once) and yields neutral pieces.
 * `onDone` fires when the outcome is known, before the `end` piece is yielded.
 */
async function* pump(
  events: AsyncIterable<RunEvent>,
  ctx: StreamContext,
  acc: Accumulated,
): AsyncGenerator<Piece> {
  const scanner = new StopScanner(ctx.stop);
  const iterator = events[Symbol.asyncIterator]();
  let closing: Promise<void> | null = null;
  const closeUpstream = (): Promise<void> =>
    (closing ??= (async () => {
      try {
        await iterator.return?.();
      } catch {
        // Closing is best effort; the outcome is already decided.
      }
    })());

  let headSent = false;
  function* ensureHead(): Generator<Piece> {
    if (!headSent) {
      headSent = true;
      yield { type: 'head' };
    }
  }

  let stopNotified = false;
  const notifyStop = (): void => {
    if (stopNotified) return;
    stopNotified = true;
    ctx.onStopMatched();
  };

  let settled = false;
  const settle = (outcome: Outcome, failure?: BridgeErrorInfo): void => {
    if (settled) return;
    settled = true;
    const base = { replyText: acc.replyText, reasoningText: acc.reasoningText };
    let result: StreamResult;
    if (outcome.kind === 'finished') {
      result = {
        ...base,
        stopMatched: outcome.stopMatched,
        finishReason: outcome.finishReason,
        usage: outcome.usage,
        error: null,
      };
    } else if (outcome.kind === 'error') {
      result = {
        ...base,
        stopMatched: outcome.stopMatched,
        finishReason: null,
        usage: null,
        error: outcome.error,
      };
    } else {
      result = {
        ...base,
        stopMatched: false,
        finishReason: null,
        usage: null,
        error: failure ?? null,
      };
    }
    ctx.onDone(result);
  };

  /** Release scanner output as a text piece. */
  function* release(text: string): Generator<Piece> {
    if (text.length === 0) return;
    yield* ensureHead();
    acc.replyText += text;
    yield { type: 'text', text };
  }

  let failure: BridgeErrorInfo | undefined;
  try {
    for (;;) {
      const step = await iterator.next();
      if (step.done) {
        const outcome: Outcome = { kind: 'aborted' };
        settle(outcome);
        yield { type: 'end', outcome };
        return;
      }
      const event = step.value;
      switch (event.type) {
        case 'started':
          yield* ensureHead();
          break;
        case 'reasoning':
          if (event.text.length > 0) {
            yield* ensureHead();
            acc.reasoningText += event.text;
            yield { type: 'reasoning', text: event.text };
          }
          break;
        case 'text': {
          const scanned = scanner.push(event.text);
          yield* release(scanned.emit);
          if (scanned.matched) {
            notifyStop();
            void closeUpstream();
            const outcome: Outcome = {
              kind: 'finished',
              finishReason: 'stop',
              usage: null,
              stopMatched: true,
            };
            settle(outcome);
            yield { type: 'end', outcome };
            return;
          }
          break;
        }
        case 'finished': {
          const scanned = scanner.flush();
          yield* release(scanned.emit);
          if (scanned.matched) notifyStop();
          yield* ensureHead();
          const outcome: Outcome = scanned.matched
            ? { kind: 'finished', finishReason: 'stop', usage: null, stopMatched: true }
            : {
                kind: 'finished',
                finishReason: event.finishReason,
                usage: event.usage,
                stopMatched: false,
              };
          settle(outcome);
          yield { type: 'end', outcome };
          return;
        }
        case 'error': {
          const scanned = scanner.flush();
          yield* release(scanned.emit);
          if (scanned.matched) notifyStop();
          const outcome: Outcome = {
            kind: 'error',
            error: event.error,
            stopMatched: scanned.matched,
          };
          settle(outcome);
          yield { type: 'end', outcome };
          return;
        }
      }
    }
  } catch (cause) {
    failure = bridgeError('upstream', 'stream mapper failed');
    throw cause;
  } finally {
    // Reached early when the consumer stops pulling, or when the events threw.
    settle({ kind: 'aborted' }, failure);
    await closeUpstream();
  }
}

export async function* toSse(
  events: AsyncIterable<RunEvent>,
  ctx: StreamContext,
): AsyncGenerator<string> {
  const acc: Accumulated = { replyText: '', reasoningText: '' };
  for await (const piece of pump(events, ctx, acc)) {
    switch (piece.type) {
      case 'head':
        yield headFrame(ctx);
        break;
      case 'reasoning':
        yield reasoningFrame(ctx, piece.text);
        break;
      case 'text':
        yield textFrame(ctx, piece.text);
        break;
      case 'end': {
        const { outcome } = piece;
        if (outcome.kind === 'finished') {
          yield finalFrame(ctx, outcome.finishReason);
          if (ctx.includeUsage && !outcome.stopMatched && outcome.usage) {
            yield usageFrame(ctx, outcome.usage);
          }
          yield SSE_DONE;
        } else if (outcome.kind === 'error') {
          yield errorFrame(outcome.error);
          yield SSE_DONE;
        }
        // aborted: the client is gone, nothing more to send.
        break;
      }
    }
  }
}

export async function toCompletion(
  events: AsyncIterable<RunEvent>,
  ctx: StreamContext,
): Promise<CompletionResult> {
  const acc: Accumulated = { replyText: '', reasoningText: '' };
  let outcome: Outcome = { kind: 'aborted' };
  for await (const piece of pump(events, ctx, acc)) {
    if (piece.type === 'end') outcome = piece.outcome;
  }
  if (outcome.kind === 'error') return { ok: false, error: outcome.error };
  if (outcome.kind === 'aborted') {
    return { ok: false, error: bridgeError('upstream', 'run ended without a result') };
  }
  const message: ChatCompletion['choices'][0]['message'] = {
    role: 'assistant',
    content: acc.replyText,
  };
  if (acc.reasoningText.length > 0) message.reasoning_content = acc.reasoningText;
  const body: ChatCompletion = {
    id: ctx.id,
    object: 'chat.completion',
    created: ctx.created,
    model: ctx.model,
    choices: [{ index: 0, message, finish_reason: outcome.finishReason }],
  };
  if (outcome.usage) body.usage = toWireUsage(outcome.usage);
  return { ok: true, body };
}
