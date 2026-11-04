// Outcome mapping (plan.md section 3.1). Pure: the run loop collects facts, this decides.
// Typed SDK fields first; message text only where no typed field exists.
import type { SDKAssistantMessageError, TerminalReason } from '@anthropic-ai/claude-agent-sdk';
import { bridgeError } from '../errors.js';
import type { BridgeErrorInfo, FinishReason, TokenUsage } from '../types.js';

export interface ResultFacts {
  isError: boolean;
  subtype: string;
  terminalReason?: TerminalReason;
  apiErrorStatus: number | null;
  /** `api_error` on the result (for example `max_output_tokens`). */
  apiError?: string;
  /** `api_error_code` on the result (for example `credits_required`). */
  apiErrorCode?: string;
  stopReason: string | null;
  /** `result.result` on success, else the first of `errors`. Claude Code's own message. */
  message: string;
  usage: TokenUsage;
}

export interface RateLimitFacts {
  /** `rate_limit_info.status === 'rejected'` */
  rejected: boolean;
  creditsRequired: boolean;
  /** Unix seconds */
  resetsAt?: number;
}

export interface OutcomeFacts {
  refusalNoFallback: boolean;
  refusalFallback: boolean;
  /** A `message_delta` or result ended with stop_reason `refusal`. */
  stopReasonRefusal: boolean;
  /** At least one `message_start` was seen: a real model call happened. */
  sawMessageStart: boolean;
  sawText: boolean;
  assistantErrors: SDKAssistantMessageError[];
  /** Text of `<synthetic>` assistant messages (local, never a reply). */
  syntheticText: string[];
  rateLimit?: RateLimitFacts;
  result?: ResultFacts;
  /** The iterator threw and no result had arrived. */
  thrownMessage?: string;
}

export type Outcome =
  | { kind: 'finished'; finishReason: FinishReason }
  | { kind: 'error'; error: BridgeErrorInfo };

export const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

const THROWN_PREFIX = 'Claude Code returned an error result: ';

/** The iterator rethrows an error result as an Error with this prefix; the text after it is Claude's message. */
export function stripThrownPrefix(message: string): string {
  return message.startsWith(THROWN_PREFIX) ? message.slice(THROWN_PREFIX.length) : message;
}

function totalTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

function retryAfter(resetsAt: number | undefined, nowSeconds: number): number | undefined {
  if (resetsAt === undefined) return undefined;
  const seconds = Math.ceil(resetsAt - nowSeconds);
  return seconds > 0 ? seconds : undefined;
}

/** Decides the terminal event once the iterator has ended. `nowSeconds` is Unix seconds. */
export function classifyOutcome(facts: OutcomeFacts, nowSeconds: number): Outcome {
  // 1-2. Refusals come first: a refusal may also set `is_error` or send an assistant error frame.
  if (facts.refusalNoFallback) return { kind: 'finished', finishReason: 'content_filter' };
  if (facts.refusalFallback) {
    return {
      kind: 'error',
      error: bridgeError('model-mismatch', 'Claude Code switched to a fallback model after a refusal; Forkline never allows that'),
    };
  }
  if (facts.stopReasonRefusal) return { kind: 'finished', finishReason: 'content_filter' };

  const result = facts.result;
  const synthetic = facts.syntheticText.length > 0;
  const text = result?.message || facts.syntheticText.at(-1) || (facts.thrownMessage ? stripThrownPrefix(facts.thrownMessage) : '');
  const failed = result?.isError === true || synthetic || facts.thrownMessage !== undefined;

  // Result with no model call and zero usage, not an error: a Claude Code command answered locally.
  if (result && !result.isError && !facts.sawMessageStart && totalTokens(result.usage) === 0) {
    return {
      kind: 'error',
      error: bridgeError('intercepted-command', 'message intercepted as a Claude Code command'),
    };
  }

  // A rejected window only counts when the run did not produce a reply.
  const noReply = failed || !facts.sawText;
  const errors = facts.assistantErrors;
  const rate = facts.rateLimit;
  if (
    errors.includes('rate_limit') ||
    result?.apiErrorStatus === 429 ||
    (noReply && (rate?.rejected || rate?.creditsRequired)) ||
    result?.apiErrorCode === 'credits_required' ||
    /requires usage credits/i.test(text)
  ) {
    const credits = rate?.creditsRequired === true || result?.apiErrorCode === 'credits_required';
    // Credits do not "reset", so their reset time is no use as a retry hint.
    const after = credits ? undefined : retryAfter(rate?.resetsAt, nowSeconds);
    return { kind: 'error', error: bridgeError('usage-limit', text || 'usage limit reached', after) };
  }
  if (errors.includes('authentication_failed') || errors.includes('oauth_org_not_allowed')) {
    return { kind: 'error', error: bridgeError('auth-failed', 'Claude Code is not signed in') };
  }
  // `blocking_limit` is Claude Code refusing to send an over-long prompt when compaction is off.
  if (result?.terminalReason === 'prompt_too_long' || result?.terminalReason === 'blocking_limit') {
    return { kind: 'error', error: bridgeError('context-too-long', text || 'prompt is too long') };
  }
  if (result?.terminalReason === 'image_error') {
    return { kind: 'error', error: bridgeError('upstream-invalid-request', text || 'image rejected') };
  }
  if (errors.includes('max_output_tokens') || result?.apiError === 'max_output_tokens') {
    return { kind: 'error', error: bridgeError('output-limit', 'reply exceeded max_tokens') };
  }
  if (errors.includes('invalid_request') || result?.apiErrorStatus === 400) {
    return { kind: 'error', error: bridgeError('upstream-invalid-request', text || 'invalid request') };
  }
  if (text.startsWith('No conversation found')) {
    return { kind: 'error', error: bridgeError('session-stale', text) };
  }
  if (failed) {
    return { kind: 'error', error: bridgeError('upstream', text || 'Claude Code reported an error') };
  }
  if (!result) {
    return { kind: 'error', error: bridgeError('upstream', 'Claude Code ended without a result') };
  }
  if (!facts.sawText) {
    return { kind: 'error', error: bridgeError('upstream', 'model returned an empty reply') };
  }
  return { kind: 'finished', finishReason: result.stopReason === 'max_tokens' ? 'length' : 'stop' };
}
