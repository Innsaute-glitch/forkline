// OpenAI wire shapes. Key order matters: it matches fixtures/golden byte for byte.
import { toErrorBody } from '../errors.js';
import type {
  BridgeErrorInfo,
  FinishReason,
  StreamContext,
  TokenUsage,
  WireUsage,
} from '../types.js';

export function toWireUsage(usage: TokenUsage): WireUsage {
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return {
    prompt_tokens: prompt,
    completion_tokens: usage.outputTokens,
    total_tokens: prompt + usage.outputTokens,
    prompt_tokens_details: { cached_tokens: usage.cacheReadTokens },
    cache_read_input_tokens: usage.cacheReadTokens,
    cache_creation_input_tokens: usage.cacheWriteTokens,
  };
}

type Delta = { role: 'assistant'; content: '' } | { content: string } | { reasoning_content: string } | Record<string, never>;

const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

function chunk(
  ctx: StreamContext,
  delta: Delta,
  finishReason: FinishReason | null,
): string {
  return frame({
    id: ctx.id,
    object: 'chat.completion.chunk',
    created: ctx.created,
    model: ctx.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

export const headFrame = (ctx: StreamContext): string =>
  chunk(ctx, { role: 'assistant', content: '' }, null);

export const reasoningFrame = (ctx: StreamContext, text: string): string =>
  chunk(ctx, { reasoning_content: text }, null);

export const textFrame = (ctx: StreamContext, text: string): string =>
  chunk(ctx, { content: text }, null);

export const finalFrame = (ctx: StreamContext, finishReason: FinishReason): string =>
  chunk(ctx, {}, finishReason);

export const usageFrame = (ctx: StreamContext, usage: TokenUsage): string =>
  frame({
    id: ctx.id,
    object: 'chat.completion.chunk',
    created: ctx.created,
    model: ctx.model,
    choices: [],
    usage: toWireUsage(usage),
  });

export const errorFrame = (error: BridgeErrorInfo): string => frame(toErrorBody(error));
