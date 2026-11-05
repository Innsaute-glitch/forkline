import { describe, expect, it } from 'vitest';
import { classifyOutcome, EMPTY_USAGE, type OutcomeFacts, type ResultFacts } from '../outcome.js';

const NOW = 1_000_000;
const facts = (over: Partial<OutcomeFacts> = {}): OutcomeFacts => ({
  refusalNoFallback: false, refusalFallback: false, stopReasonRefusal: false,
  sawMessageStart: true, sawText: true, assistantErrors: [], syntheticText: [], ...over,
});
const result = (over: Partial<ResultFacts> = {}): ResultFacts => ({
  isError: false, subtype: 'success', apiErrorStatus: null, stopReason: 'end_turn', message: 'reply',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, ...over,
});
const errorOf = (f: OutcomeFacts) => {
  const o = classifyOutcome(f, NOW);
  if (o.kind !== 'error') throw new Error(`expected error, got ${JSON.stringify(o)}`);
  return o.error;
};

describe('classifyOutcome', () => {
  it('finishes with stop on a normal successful turn', () => {
    expect(classifyOutcome(facts({ result: result() }), NOW)).toEqual({ kind: 'finished', finishReason: 'stop' });
  });
  it('finishes with length only for a successful turn that ended at max_tokens', () => {
    expect(classifyOutcome(facts({ result: result({ stopReason: 'max_tokens' }) }), NOW)).toEqual({ kind: 'finished', finishReason: 'length' });
  });
  it('refusal wins over is_error and an assistant error frame', () => {
    const f = facts({ refusalNoFallback: true, result: result({ isError: true }), assistantErrors: ['unknown'], syntheticText: ['x'] });
    expect(classifyOutcome(f, NOW)).toEqual({ kind: 'finished', finishReason: 'content_filter' });
    expect(classifyOutcome(facts({ stopReasonRefusal: true, result: result({ isError: true }) }), NOW)).toEqual({ kind: 'finished', finishReason: 'content_filter' });
  });
  it('a fallback refusal trips the model guard', () => {
    expect(errorOf(facts({ refusalFallback: true, result: result() })).code).toBe('model-mismatch');
  });
  it('an error subtype is an error even without is_error', () => {
    const e = errorOf(facts({ sawText: true, result: result({ subtype: 'error_during_execution', message: 'broke' }) }));
    expect(e).toMatchObject({ code: 'upstream', message: 'broke' });
  });

  it('an earlier error frame does not undo a finished reply', () => {
    const f = facts({ sawText: true, assistantErrors: ['max_output_tokens'], result: result({ message: '' }) });
    expect(classifyOutcome(f, NOW)).toEqual({ kind: 'finished', finishReason: 'stop' });
  });

  it('is_error with subtype success is never a reply', () => {
    const e = errorOf(facts({ result: result({ isError: true, message: 'something broke' }) }));
    expect(e).toMatchObject({ code: 'upstream', status: 502, message: 'something broke' });
  });
  it('a synthetic assistant message is never a reply, and is not a model mismatch', () => {
    const e = errorOf(facts({ sawText: false, syntheticText: ['local text'], result: result({ message: 'local text' }) }));
    expect(e).toMatchObject({ code: 'upstream', message: 'local text' });
  });
  it('a result with no model call and zero usage is an intercepted command', () => {
    const f = facts({ sawMessageStart: false, sawText: false, syntheticText: ["/help isn't available"], result: result({ usage: EMPTY_USAGE }) });
    expect(errorOf(f)).toEqual({ code: 'intercepted-command', status: 400, message: 'message intercepted as a Claude Code command' });
  });
  it('maps credits and rate limits to usage-limit', () => {
    const credits = errorOf(facts({
      sawMessageStart: false, sawText: false, assistantErrors: ['rate_limit'], syntheticText: ['Fable 5 requires usage credits. Switch to another model to continue.'],
      rateLimit: { rejected: true, creditsRequired: true, resetsAt: NOW + 5000 },
      result: result({ isError: true, apiErrorStatus: 429, apiErrorCode: 'credits_required', message: 'Fable 5 requires usage credits. Switch to another model to continue.', usage: EMPTY_USAGE }),
    }));
    expect(credits).toEqual({ code: 'usage-limit', status: 429, message: 'Fable 5 requires usage credits. Switch to another model to continue.' });
    const limited = errorOf(facts({ sawText: false, assistantErrors: ['rate_limit'], rateLimit: { rejected: true, creditsRequired: false, resetsAt: NOW + 3600.2 }, result: result({ isError: true, message: 'limit' }) }));
    expect(limited).toMatchObject({ code: 'usage-limit', status: 429, retryAfterSeconds: 3601 });
    expect(errorOf(facts({ sawText: false, rateLimit: { rejected: true, creditsRequired: false, resetsAt: NOW - 5 }, result: result({ isError: true }) })).retryAfterSeconds).toBeUndefined();
  });
  it('ignores a rejected window when the run produced a reply', () => {
    const f = facts({ rateLimit: { rejected: true, creditsRequired: false }, result: result() });
    expect(classifyOutcome(f, NOW).kind).toBe('finished');
  });
  it('maps auth failures', () => {
    for (const code of ['authentication_failed', 'oauth_org_not_allowed'] as const) {
      expect(errorOf(facts({ sawText: false, assistantErrors: [code], result: result({ isError: true }) }))).toEqual({ code: 'auth-failed', status: 502, message: 'Claude Code is not signed in' });
    }
  });
  it('maps terminal reasons', () => {
    expect(errorOf(facts({ sawText: false, result: result({ isError: true, terminalReason: 'prompt_too_long', message: 'Prompt is too long' }) }))).toMatchObject({ code: 'context-too-long', status: 400, message: 'Prompt is too long' });
    expect(errorOf(facts({ sawText: false, result: result({ isError: true, terminalReason: 'blocking_limit' }) })).code).toBe('context-too-long');
    expect(errorOf(facts({ sawText: false, result: result({ isError: true, terminalReason: 'image_error', message: 'bad image' }) }))).toMatchObject({ code: 'upstream-invalid-request', message: 'bad image' });
  });
  it('maps an output limit after partial text', () => {
    const e = errorOf(facts({ assistantErrors: ['max_output_tokens'], syntheticText: ['API Error: exceeded'], result: result({ isError: true, apiError: 'max_output_tokens' }) }));
    expect(e).toEqual({ code: 'output-limit', status: 400, message: 'reply exceeded max_tokens' });
  });
  it('maps invalid requests by typed field', () => {
    expect(errorOf(facts({ sawText: false, result: result({ isError: true, apiErrorStatus: 400, message: 'API Error: 400 bad' }) }))).toMatchObject({ code: 'upstream-invalid-request', message: 'API Error: 400 bad' });
    expect(errorOf(facts({ sawText: false, assistantErrors: ['invalid_request'], result: result({ isError: true }) })).code).toBe('upstream-invalid-request');
  });
  it('maps a missing session, from the result or from a throw', () => {
    const msg = 'No conversation found with session ID: abc';
    expect(errorOf(facts({ sawMessageStart: false, sawText: false, result: result({ isError: true, subtype: 'error_during_execution', message: msg, usage: EMPTY_USAGE }) })).code).toBe('session-stale');
    expect(errorOf(facts({ sawMessageStart: false, sawText: false, thrownMessage: msg })).code).toBe('session-stale');
  });
  it('an empty successful reply is upstream, even with reasoning', () => {
    expect(errorOf(facts({ sawText: false, result: result({ message: '' }) }))).toEqual({ code: 'upstream', status: 502, message: 'model returned an empty reply' });
  });
  it('anything else is upstream with the error text', () => {
    expect(errorOf(facts({ sawText: false, thrownMessage: 'spawn failed' }))).toMatchObject({ code: 'upstream', message: 'spawn failed' });
    expect(errorOf(facts({ sawText: false }))).toMatchObject({ code: 'upstream', message: 'Claude Code ended without a result' });
  });
});
