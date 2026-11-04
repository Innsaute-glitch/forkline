import type { Config } from '../config.js';
import { ADJUSTMENT, REJECT_EXEMPT } from '../constants.js';
import { bridgeError } from '../errors.js';
import type { ChatRequest, TranslateResult } from '../types.js';
import { splitMessages } from './messages.js';
import { resolveParams } from './params.js';

/** Pure: turns an OpenAI chat request into what the router and runner need, or a 400. */
export function translate(request: ChatRequest, config: Config): TranslateResult {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { ok: false, error: bridgeError('invalid-request', 'request body must be a JSON object') };
  }

  const split = splitMessages(request.messages);
  if (!split.ok) return split;
  const resolved = resolveParams(request, config);
  if (!resolved.ok) return resolved;

  const adjustments = [
    ...new Set([
      ADJUSTMENT.systemHeaderAdded,
      // The router replaces this text only on a rebuilt chat, which is any non-empty history.
      ...(split.value.history.length > 0 ? [ADJUSTMENT.environmentBlockReplaced] : []),
      ...split.value.adjustments,
      ...resolved.value.adjustments,
    ]),
  ].sort();

  if (config.adjustments === 'reject') {
    const rejected = adjustments.filter((name) => !REJECT_EXEMPT.includes(name));
    if (rejected.length > 0) {
      return {
        ok: false,
        error: bridgeError(
          'adjustment-rejected',
          `this request would need adjustments, and adjustments is set to "reject": ${rejected.join(', ')}`,
        ),
      };
    }
  }

  return {
    ok: true,
    value: {
      responseModel: resolved.value.responseModel,
      claudeModel: resolved.value.claudeModel,
      systemPrompt: [config.systemHeader, ...split.value.systemTexts],
      history: split.value.history,
      livePrompt: split.value.livePrompt,
      params: resolved.value.params,
      adjustments,
    },
  };
}
