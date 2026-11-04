import type { Config } from '../config.js';
import { ADJUSTMENT, HANDLED_FIELDS, ignoredField } from '../constants.js';
import { bridgeError } from '../errors.js';
import type { ChatRequest, EffortLevel, RequestParams } from '../types.js';
import type { Result } from './messages.js';

const fail = (message: string): { ok: false; error: ReturnType<typeof bridgeError> } => ({
  ok: false,
  error: bridgeError('invalid-request', message),
});

const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_ALIASES: readonly string[] = ['minimal', 'none'];

/** `null` counts as unset everywhere. */
const isSet = (value: unknown): boolean => value !== undefined && value !== null;

export interface ResolvedParams {
  responseModel: string;
  claudeModel: string;
  params: RequestParams;
  adjustments: string[];
}

export function resolveParams(request: ChatRequest, config: Config): Result<ResolvedParams> {
  const adjustments = new Set<string>();

  // model
  const requestedModel = request.model;
  if (isSet(requestedModel) && typeof requestedModel !== 'string') return fail('model must be a string');
  const known = config.models.find((model) => model.id === requestedModel);
  const model = known ?? config.models.find((entry) => entry.id === config.defaultModel);
  if (!model) throw new Error('config.defaultModel is not in config.models'); // config validation prevents this
  if (!known) adjustments.add(ADJUSTMENT.modelDefaulted);
  const responseModel =
    typeof requestedModel === 'string' && requestedModel !== '' ? requestedModel : config.defaultModel;

  // stream
  if (isSet(request.stream) && typeof request.stream !== 'boolean') return fail('stream must be a boolean');

  // n, response_format
  if (isSet(request.n) && request.n !== 1) return fail('n must be 1; multiple choices are not supported');
  if (isSet(request.response_format)) return fail('response_format is not supported');

  // tools
  if (isSet(request.tools) || isSet(request.tool_choice)) adjustments.add(ADJUSTMENT.toolsIgnored);

  // max_completion_tokens, then max_tokens: the first one set wins
  let maxOutputTokens: number | null = null;
  const tokenField = isSet(request.max_completion_tokens)
    ? 'max_completion_tokens'
    : isSet(request.max_tokens)
      ? 'max_tokens'
      : null;
  if (tokenField) {
    const value = request[tokenField];
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      return fail(`${tokenField} must be a positive integer`);
    }
    maxOutputTokens = value;
    if (model.maxOutputTokens !== undefined && value > model.maxOutputTokens) {
      maxOutputTokens = model.maxOutputTokens;
      adjustments.add(ADJUSTMENT.maxTokensCapped);
    }
  }

  // reasoning_effort
  let effort: EffortLevel = config.defaultEffort;
  if (isSet(request.reasoning_effort)) {
    const value = request.reasoning_effort;
    if (typeof value === 'string' && EFFORTS.includes(value)) {
      effort = value as EffortLevel;
    } else if (typeof value === 'string' && EFFORT_ALIASES.includes(value)) {
      effort = 'low';
      adjustments.add(ADJUSTMENT.effortMapped);
    } else {
      return fail('reasoning_effort must be one of minimal, none, low, medium, high, xhigh, max');
    }
  }

  // stop
  let stop: string[] = [];
  if (isSet(request.stop)) {
    const value = request.stop;
    const list = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string')) {
      return fail('stop must be a string or an array of strings');
    }
    stop = (list as string[]).filter((entry) => entry !== '');
  }

  // stream_options
  const options = request.stream_options;
  const includeUsage = !(
    typeof options === 'object' &&
    options !== null &&
    (options as Record<string, unknown>).include_usage === false
  );

  // every other field becomes <field>-ignored
  for (const [field, value] of Object.entries(request)) {
    if (!HANDLED_FIELDS.includes(field) && isSet(value)) adjustments.add(ignoredField(field));
  }

  return {
    ok: true,
    value: {
      responseModel,
      claudeModel: model.claudeModel,
      params: { stream: request.stream === true, effort, maxOutputTokens, stop, includeUsage },
      adjustments: [...adjustments],
    },
  };
}
