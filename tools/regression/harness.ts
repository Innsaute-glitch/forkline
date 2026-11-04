// Shared plumbing for the checks: config, building requests through the real translator and
// router, running them through the real runner, and the pass/fail/skip vocabulary.
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../../src/config.js';
import { loadConfig } from '../../src/config.js';
import { ENV } from '../../src/constants.js';
import { createLogger } from '../../src/logger.js';
import { MemorySessionStore } from '../../src/router/memory-store.js';
import { createRouter } from '../../src/router/index.js';
import { run } from '../../src/runner/index.js';
import { translate } from '../../src/translator/index.js';
import type {
  BridgeErrorInfo,
  ChatRequest,
  OpenAIMessage,
  RoutePlan,
  RunEvent,
  TokenUsage,
  TranslatedRequest,
} from '../../src/types.js';
import { DUMMY_TOKEN } from './capture.js';

export const HAIKU = 'claude-haiku-5-5';

/** A check ended in a skip: reported, and the suite still passes. */
export class Skip extends Error {}
/** The suite must stop: a real usage limit was hit. Nothing is retried. */
export class StopSuite extends Error {}
/** An expectation did not hold. The message is the line shown to the user. */
export class Failure extends Error {}

export interface Ctx {
  /** Real token, temp directories. Live calls only. */
  config: Config;
  /** Dummy token. The only config the capture method may use. */
  captureConfig: Config;
  root: string;
  workDir: string;
  /** Set for a deliberately wrong run: `expect` returns a value that cannot match. */
  wrong: boolean;
  /** Short progress notes under the current check's line. */
  note: (text: string) => void;
  /** Live calls made so far, for the summary. */
  liveCalls: { count: number };
}

export function makeContext(options: { wrong: boolean; note: (text: string) => void }): { ctx: Ctx; cleanup: () => void } {
  const base = loadConfig();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forkline-regression-')));
  const workDir = join(root, 'work');
  mkdirSync(workDir);
  const paths = { workDir, configDir: join(root, 'claude-config') };
  const config: Config = { ...base, paths };
  const captureConfig: Config = {
    ...base,
    paths: { ...paths, configDir: join(root, 'capture-config') },
    secrets: { ...base.secrets, claudeToken: DUMMY_TOKEN },
  };
  if (!config.secrets.claudeToken) throw new Error(`${ENV.claudeToken} is not set`);
  const ctx: Ctx = { config, captureConfig, root, workDir, wrong: options.wrong, note: options.note, liveCalls: { count: 0 } };
  return { ctx, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** The expected value, or one that cannot match when the run is deliberately wrong. */
export const expected = <T>(ctx: Ctx, right: T, wrong: T): T => (ctx.wrong ? wrong : right);

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Failure(message);
}

export const quote = (text: string, max = 160): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return JSON.stringify(flat.length > max ? `${flat.slice(0, max)}...` : flat);
};

// ---- Requests ----

export const user = (content: string): OpenAIMessage => ({ role: 'user', content });
export const assistant = (content: string): OpenAIMessage => ({ role: 'assistant', content });
export const system = (content: string): OpenAIMessage => ({ role: 'system', content });

/** An OpenAI-shaped request through the real translator. Haiku, low effort unless told otherwise. */
export function translateChat(
  ctx: Ctx,
  messages: OpenAIMessage[],
  options: { model?: string; effort?: string; extra?: Record<string, unknown> } = {},
): TranslatedRequest {
  const request: ChatRequest = {
    model: options.model ?? HAIKU,
    messages,
    stream: true,
    reasoning_effort: options.effort ?? 'low',
    ...options.extra,
  };
  const result = translate(request, ctx.config);
  if (!result.ok) throw new Error(`translate failed (a suite bug): ${result.error.message}`);
  const { value } = result;
  if (value.claudeModel !== (options.model ?? HAIKU)) throw new Error(`model ${options.model ?? HAIKU} is not in the config`);
  return value;
}

/** The same request with a different model, for check 13 (the configured model list). */
export const withModel = (translated: TranslatedRequest, claudeModel: string): TranslatedRequest => ({
  ...translated,
  claudeModel,
});

export function newPlan(): RoutePlan {
  return { case: 'A', sessionId: randomUUID(), sessionStore: new MemorySessionStore(), lockKey: null };
}

/** Case B: resume a session whose whole sequence is stored, as the plan's table defines it. */
export const resumePlan = (source: RoutePlan): RoutePlan => ({
  case: 'B',
  sessionId: source.sessionId,
  sessionStore: source.sessionStore,
  resume: source.sessionId,
  lockKey: null,
});

export function routerFor(ctx: Ctx, config: Config = ctx.config) {
  return createRouter(config, createLogger('silent'));
}

// ---- Running ----

export interface Chat {
  plan: RoutePlan;
  events: RunEvent[];
  text: string;
  reasoning: string;
  startedModel: string | null;
  finishReason: string | null;
  usage: TokenUsage | null;
  error: BridgeErrorInfo | null;
  /** Everything the prompt cost: input + cache read + cache write. */
  totalInput: number;
}

/** Runs one request through the real router and runner. A real usage limit stops the suite. */
export async function chat(ctx: Ctx, translated: TranslatedRequest, plan?: RoutePlan, signal?: AbortSignal): Promise<Chat> {
  const routed = plan ?? (await routerFor(ctx).route(translated));
  ctx.liveCalls.count++;
  const events: RunEvent[] = [];
  const controller = new AbortController();
  for await (const event of run({ translated, plan: routed, config: ctx.config, signal: signal ?? controller.signal })) {
    events.push(event);
  }
  const result = summarize(routed, events);
  if (result.error?.code === 'usage-limit' && !isCreditsMessage(result.error)) {
    throw new StopSuite(`usage limit reached (${result.error.message}); stopping without retrying`);
  }
  return result;
}

/** The credits reply is per model and not a rate limit. Anything else under `usage-limit` is a real limit. */
export const isCreditsMessage = (error: BridgeErrorInfo): boolean => /credit/i.test(error.message);

export function summarize(plan: RoutePlan, events: RunEvent[]): Chat {
  let text = '';
  let reasoning = '';
  let startedModel: string | null = null;
  let finishReason: string | null = null;
  let usage: TokenUsage | null = null;
  let error: BridgeErrorInfo | null = null;
  for (const event of events) {
    if (event.type === 'text') text += event.text;
    else if (event.type === 'reasoning') reasoning += event.text;
    else if (event.type === 'started') startedModel = event.model;
    else if (event.type === 'finished') {
      finishReason = event.finishReason;
      usage = event.usage;
    } else if (event.type === 'error') error = event.error;
  }
  const totalInput = usage ? usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens : 0;
  return { plan, events, text, reasoning, startedModel, finishReason, usage, error, totalInput };
}

/** Throws a Failure naming the error when a live run did not finish with a reply. */
export function mustReply(label: string, result: Chat): void {
  if (result.error) {
    throw new Failure(`${label}: ${result.error.code} (${result.error.status}): ${quote(result.error.message)}`);
  }
  assert(result.finishReason === 'stop', `${label}: finished with ${String(result.finishReason)} instead of stop`);
  assert(result.text.trim().length > 0, `${label}: empty reply`);
}

export const has = (text: string, word: string): boolean => text.toLowerCase().includes(word.toLowerCase());

/** Invented filler of about `chars` characters, different on every call by way of `nonce`. */
export function padding(nonce: string, chars: number): string {
  const nouns = ['harbour', 'lantern', 'orchard', 'ferry', 'ledger', 'compass', 'kettle', 'meadow', 'anvil', 'quarry', 'thicket', 'granary'];
  const verbs = ['mends', 'counts', 'carries', 'polishes', 'borrows', 'weighs', 'paints', 'repairs', 'stacks', 'names'];
  const out: string[] = [];
  let length = 0;
  for (let i = 0; length < chars; i++) {
    const line = `Note ${nonce}-${i}: the ${nouns[i % nouns.length]} keeper ${verbs[(i * 7) % verbs.length]} ${(i * 37) % 91 + 3} ${nouns[(i * 5 + 3) % nouns.length]}s before ${nouns[(i * 11 + 1) % nouns.length]} bell number ${(i * 53) % 977}.`;
    out.push(line);
    length += line.length + 1;
  }
  return out.join('\n');
}
