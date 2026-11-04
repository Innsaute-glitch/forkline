// STUB. Task 2 replaces this file. Replays a fixture so other tasks can start.
import { readFileSync } from 'node:fs';
import type { Config } from '../config.js';
import type { RateLimitSnapshot, RoutePlan, RunEvent, TranslatedRequest } from '../types.js';

export interface RunInput {
  translated: TranslatedRequest;
  plan: RoutePlan;
  config: Config;
  /** Aborted on client disconnect or a stop match. */
  signal: AbortSignal;
}

export type RunFn = (input: RunInput) => AsyncGenerator<RunEvent>;

export async function* run(_input: RunInput): AsyncGenerator<RunEvent> {
  const url = new URL('../../fixtures/run-events/thinking-then-text.json', import.meta.url);
  yield* JSON.parse(readFileSync(url, 'utf8')) as RunEvent[];
}

export function latestRateLimits(): RateLimitSnapshot | null {
  return null;
}
