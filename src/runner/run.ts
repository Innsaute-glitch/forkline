// The run loop: one SDK `query()` turned into RunEvents (plan.md section 3.1, "Runner event rules").
import { query as sdkQuery, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from '../config.js';
import { bridgeError } from '../errors.js';
import { createLogger, type Logger } from '../logger.js';
import type { RoutePlan, RunEvent, TokenUsage, TranslatedRequest } from '../types.js';
import { servedModelMatches } from './guard.js';
import { removeLocalTranscript } from './local-transcript.js';
import { buildPrompt, buildQueryOptions } from './options.js';
import {
  classifyOutcome,
  EMPTY_USAGE,
  stripThrownPrefix,
  type OutcomeFacts,
  type ResultFacts,
} from './outcome.js';
import { recordRateLimit } from './rate-limits.js';

export interface RunInput {
  translated: TranslatedRequest;
  plan: RoutePlan;
  config: Config;
  /** Aborted on client disconnect or a stop match. */
  signal: AbortSignal;
}

export type RunFn = (input: RunInput) => AsyncGenerator<RunEvent>;

/** The part of the SDK `query` that the loop uses. Tests pass a fake. */
export type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query;

let defaultLog: Logger | null = null;
const log = (): Logger => (defaultLog ??= createLogger());

function usageOf(raw: unknown): TokenUsage {
  const u = (raw ?? {}) as Record<string, number | undefined>;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

function resultFacts(m: Extract<SDKMessage, { type: 'result' }>): ResultFacts {
  const loose = m as unknown as Record<string, unknown>;
  const errors = (loose.errors as string[] | undefined) ?? [];
  return {
    isError: m.is_error,
    subtype: m.subtype,
    terminalReason: m.terminal_reason,
    apiErrorStatus: (loose.api_error_status as number | null | undefined) ?? null,
    apiError: loose.api_error as string | undefined,
    apiErrorCode: loose.api_error_code as string | undefined,
    stopReason: m.stop_reason,
    // On a good result `result` is the reply itself, which must never be read as error text.
    message: m.subtype === 'success' ? (m.is_error ? m.result : '') : (errors[0] ?? ''),
    usage: usageOf(m.usage),
  };
}

/** An aborted subprocess takes a few seconds to exit and can still write, so look again after that. */
const LATE_WRITE_MS = 10_000;

function removeTranscript(configDir: string, sessionId: string): void {
  const remove = (): void => {
    try {
      removeLocalTranscript(configDir, sessionId);
    } catch (cause) {
      log().warn({ sessionId, error: cause instanceof Error ? cause.message : 'unknown' }, 'cannot remove local transcript');
    }
  };
  remove();
  setTimeout(remove, LATE_WRITE_MS).unref();
}

/**
 * Runs one request. Never retries (plan.md section 3.1). Ends with exactly one `finished` or
 * `error`, except when `signal` aborts: then it ends with no terminal event. `return()` stops the
 * subprocess the same way an abort does.
 */
export async function* run(input: RunInput, queryFn: QueryFn = sdkQuery): AsyncGenerator<RunEvent> {
  const { translated, plan, config, signal } = input;
  if (signal.aborted) return;

  const abort = new AbortController();
  const onSignal = (): void => abort.abort();
  signal.addEventListener('abort', onSignal, { once: true });

  let timedOut: 'idle' | 'deadline' | null = null;
  let timer: NodeJS.Timeout | undefined;
  const arm = (ms: number, kind: 'idle' | 'deadline'): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = kind;
      abort.abort();
    }, ms);
  };

  const facts: OutcomeFacts = {
    refusalNoFallback: false,
    refusalFallback: false,
    stopReasonRefusal: false,
    sawMessageStart: false,
    sawText: false,
    assistantErrors: [],
    syntheticText: [],
  };
  let started = false;
  let refusalCategory: string | null = null;
  let guardError: string | null = null;
  let query: Query | undefined;

  try {
    // Until the model starts replying only the absolute deadline applies; then the idle timer.
    arm(config.timeouts.deadlineMs, 'deadline');
    query = queryFn({
      prompt: buildPrompt(translated.livePrompt),
      options: buildQueryOptions(translated, plan, config, abort),
    });

    for await (const m of query) {
      if (started) arm(config.timeouts.streamIdleMs, 'idle');
      if (m.type === 'system') {
        if (m.subtype === 'init') {
          if (!servedModelMatches(translated.claudeModel, m.model)) {
            guardError = `requested ${translated.claudeModel} but Claude Code reported ${m.model}`;
            break;
          }
        } else if (m.subtype === 'model_refusal_no_fallback') {
          facts.refusalNoFallback = true;
          refusalCategory = m.api_refusal_category ?? null;
        } else if (m.subtype === 'model_refusal_fallback') {
          facts.refusalFallback = true;
          refusalCategory = m.api_refusal_category ?? null;
        } else if (m.subtype === 'mirror_error') {
          log().warn({ sessionId: m.key.sessionId }, 'transcript store append failed');
        }
      } else if (m.type === 'stream_event') {
        if (m.parent_tool_use_id !== null) continue;
        const ev = m.event;
        if (ev.type === 'message_start') {
          if (!servedModelMatches(translated.claudeModel, ev.message.model)) {
            guardError = `requested ${translated.claudeModel} but the reply came from ${ev.message.model}`;
            break;
          }
          facts.sawMessageStart = true;
          if (!started) {
            started = true;
            arm(config.timeouts.streamIdleMs, 'idle');
            yield { type: 'started', sessionId: plan.sessionId, model: ev.message.model };
          }
        } else if (ev.type === 'message_delta') {
          if (ev.delta.stop_reason === 'refusal') facts.stopReasonRefusal = true;
        } else if (ev.type === 'content_block_delta' && started) {
          if (ev.delta.type === 'thinking_delta') {
            if (ev.delta.thinking) yield { type: 'reasoning', text: ev.delta.thinking };
          } else if (ev.delta.type === 'text_delta') {
            if (ev.delta.text) {
              facts.sawText = true;
              yield { type: 'text', text: ev.delta.text };
            }
          }
        }
      } else if (m.type === 'assistant') {
        if (m.parent_tool_use_id !== null) continue;
        if (m.error) facts.assistantErrors.push(m.error);
        if (m.message.model === '<synthetic>') {
          for (const block of m.message.content) {
            if (block.type === 'text') facts.syntheticText.push(block.text);
          }
        }
      } else if (m.type === 'rate_limit_event') {
        recordRateLimit(m.rate_limit_info);
        const info = m.rate_limit_info;
        if (info.status === 'rejected' || info.errorCode === 'credits_required') {
          facts.rateLimit = {
            rejected: info.status === 'rejected',
            creditsRequired: info.errorCode === 'credits_required',
            resetsAt: info.resetsAt,
          };
        }
      } else if (m.type === 'result') {
        facts.result = resultFacts(m);
        if (m.stop_reason === 'refusal') facts.stopReasonRefusal = true;
        // Keep draining: the last transcript entries reach the store before the iterator ends.
      }
    }
  } catch (cause) {
    // A result usually arrives first and the iterator then throws the same error; the result wins.
    if (!facts.result && !signal.aborted && !timedOut) {
      facts.thrownMessage = stripThrownPrefix(cause instanceof Error ? cause.message : String(cause));
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onSignal);
    abort.abort();
    query?.close();
    removeTranscript(config.paths.configDir, plan.sessionId);
  }

  if (signal.aborted) return;
  if (guardError) {
    yield { type: 'error', error: bridgeError('model-mismatch', guardError) };
    return;
  }
  if (timedOut && !facts.result) {
    const message =
      timedOut === 'idle'
        ? `no output from Claude Code for ${Math.round(config.timeouts.streamIdleMs / 1000)} s`
        : `Claude Code did not start replying within ${Math.round(config.timeouts.deadlineMs / 1000)} s`;
    yield { type: 'error', error: bridgeError('timeout', message) };
    return;
  }

  const outcome = classifyOutcome(facts, Date.now() / 1000);
  if (facts.refusalNoFallback || facts.refusalFallback || facts.stopReasonRefusal) {
    // Metadata only: Claude's explanation can quote the chat, so it is never logged.
    log().warn(
      {
        model: translated.claudeModel,
        routeCase: plan.case,
        category: refusalCategory,
        noFallbackNotice: facts.refusalNoFallback,
        fallbackNotice: facts.refusalFallback,
        stopReasonRefusal: facts.stopReasonRefusal,
        isError: facts.result?.isError ?? null,
        sawText: facts.sawText,
        started,
      },
      'model refused',
    );
  }
  if (outcome.kind === 'error') {
    yield { type: 'error', error: outcome.error };
    return;
  }
  if (!started) {
    // A refusal can arrive without a streamed reply; the model call still happened.
    yield { type: 'started', sessionId: plan.sessionId, model: translated.claudeModel };
  }
  yield {
    type: 'finished',
    sessionId: plan.sessionId,
    finishReason: outcome.finishReason,
    usage: facts.result?.usage ?? EMPTY_USAGE,
  };
}
