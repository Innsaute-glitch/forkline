// STUB. Task 3 replaces this file. Replays golden output so other tasks can start.
import { readFileSync } from 'node:fs';
import type { ChatCompletion, CompletionResult, RunEvent, StreamContext } from '../types.js';

/** Expects the full event sequence, starting with `started`. Yields whole SSE frames. */
export async function* toSse(
  _events: AsyncIterable<RunEvent>,
  ctx: StreamContext,
): AsyncGenerator<string> {
  const url = new URL('../../fixtures/golden/sse/thinking-then-text.sse', import.meta.url);
  for (const frame of readFileSync(url, 'utf8').split(/(?<=\n\n)/)) yield frame;
  ctx.onDone({
    replyText: '"Stay by the fire."',
    reasoningText: 'She is wary.',
    stopMatched: false,
    finishReason: 'stop',
    usage: null,
    error: null,
  });
}

export async function toCompletion(
  _events: AsyncIterable<RunEvent>,
  _ctx: StreamContext,
): Promise<CompletionResult> {
  const url = new URL('../../fixtures/golden/completion/thinking-then-text.json', import.meta.url);
  return { ok: true, body: JSON.parse(readFileSync(url, 'utf8')) as ChatCompletion };
}
