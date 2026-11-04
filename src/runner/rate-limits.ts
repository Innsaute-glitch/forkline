import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import type { RateLimitSnapshot, RateLimitWindow } from '../types.js';

const STATUSES = new Set<string>(['allowed', 'allowed_warning', 'rejected']);

/** Claude Code also reports every window in `unifiedWindows`; the SDK type does not list it. */
interface UnifiedWindow {
  status?: string;
  utilization?: number;
  resetsAt?: number;
}

let snapshot: RateLimitSnapshot = {};

function setWindow(
  type: string,
  status: string | undefined,
  utilization: number | undefined,
  resetsAt: number | undefined,
  updatedAt: string,
): void {
  if (status === undefined || !STATUSES.has(status)) return;
  snapshot[type] = {
    status: status as RateLimitWindow['status'],
    utilization: utilization ?? null,
    resetsAt: resetsAt ?? null,
    updatedAt,
  };
}

/** Keeps the newest value of every window. Values pass through unchanged. */
export function recordRateLimit(info: SDKRateLimitInfo, now: Date = new Date()): void {
  const updatedAt = now.toISOString();
  const unified = (info as { unifiedWindows?: Record<string, UnifiedWindow> }).unifiedWindows;
  if (unified) {
    for (const [type, window] of Object.entries(unified)) {
      setWindow(type, window.status ?? info.status, window.utilization, window.resetsAt, updatedAt);
    }
  }
  if (info.rateLimitType && !(unified && info.rateLimitType in unified)) {
    setWindow(info.rateLimitType, info.status, info.utilization, info.resetsAt, updatedAt);
  }
}

export function latestRateLimits(): RateLimitSnapshot | null {
  const types = Object.keys(snapshot);
  if (types.length === 0) return null;
  return Object.fromEntries(types.map((type) => [type, { ...snapshot[type]! }]));
}

/** Test helper. */
export function resetRateLimits(): void {
  snapshot = {};
}
