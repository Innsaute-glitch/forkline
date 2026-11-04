import type { BridgeErrorCode, BridgeErrorInfo, ErrorBody } from './types.js';

export const STATUS_BY_CODE: Record<BridgeErrorCode, number> = {
  'invalid-request': 400,
  'adjustment-rejected': 400,
  'intercepted-command': 400,
  'upstream-invalid-request': 400,
  'context-too-long': 400,
  'output-limit': 400,
  unauthorized: 401,
  'not-found': 404,
  'body-too-large': 413,
  'usage-limit': 429,
  'auth-failed': 502,
  'model-mismatch': 502,
  'session-stale': 502,
  upstream: 502,
  'queue-full': 503,
  timeout: 504,
};

export function bridgeError(
  code: BridgeErrorCode,
  message: string,
  retryAfterSeconds?: number,
): BridgeErrorInfo {
  const info: BridgeErrorInfo = { code, status: STATUS_BY_CODE[code], message };
  if (retryAfterSeconds !== undefined) info.retryAfterSeconds = retryAfterSeconds;
  return info;
}

export function toErrorBody(info: BridgeErrorInfo): ErrorBody {
  return { error: { message: info.message, type: info.code, code: info.status } };
}
