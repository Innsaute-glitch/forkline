// Local request capture: the position and content checks need the exact request Claude Code sends.
// Method (for position checks): point ANTHROPIC_BASE_URL at a throwaway server on
// 127.0.0.1 with a dummy token, record the request body, answer 400, forward nothing. The real token
// never gets near this path: the capture config carries a dummy, and `assertNoRealToken` checks it.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from '../../src/config.js';
import { CLAUDE_ENV } from '../../src/constants.js';
import { buildPrompt, buildQueryOptions } from '../../src/runner/index.js';
import type { RoutePlan, TranslatedRequest } from '../../src/types.js';

export const DUMMY_TOKEN = 'regression-dummy-token-not-a-credential';

export interface WireMessage {
  role: string;
  content: string | { type: string; text?: string }[];
}

export interface CapturedBody {
  model?: string;
  system?: string | { type: string; text: string }[];
  messages: WireMessage[];
  tools?: unknown[];
  [key: string]: unknown;
}

export interface Captured {
  /** The first main messages request. Claude Code retries a 400, so later ones are identical copies. */
  body: CapturedBody;
  path: string;
  requestCount: number;
}

/** One line per content block: role and its text, images shown as a marker. */
export interface FlatMessage {
  role: string;
  text: string;
}

const blockText = (block: { type: string; text?: string }): string =>
  block.type === 'text' ? (block.text ?? '') : `[${block.type}]`;

export function flattenMessages(body: CapturedBody): FlatMessage[] {
  return body.messages.map((message) => ({
    role: message.role,
    text:
      typeof message.content === 'string'
        ? message.content
        : message.content.map(blockText).join('\n'),
  }));
}

export function systemBlocks(body: CapturedBody): string[] {
  if (body.system === undefined) return [];
  if (typeof body.system === 'string') return [body.system];
  return body.system.map((block) => block.text);
}

/** Index of the first message whose text contains `needle`, or -1. */
export const indexOfText = (messages: FlatMessage[], needle: string): number =>
  messages.findIndex((message) => message.text.includes(needle));

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

interface CaptureServer {
  server: Server;
  baseUrl: string;
  /** Resolves with the first /v1/messages request. */
  first: Promise<Omit<Captured, 'requestCount'>>;
  count: () => number;
}

async function startCaptureServer(isMain: (body: CapturedBody) => boolean): Promise<CaptureServer> {
  let resolveFirst!: (value: Omit<Captured, 'requestCount'>) => void;
  const first = new Promise<Omit<Captured, 'requestCount'>>((resolve) => (resolveFirst = resolve));
  let count = 0;
  let seen = false;
  const server = createServer((request, response) => {
    void readBody(request).then((raw) => {
      const path = request.url ?? '';
      if (request.method === 'POST' && /\/v1\/messages(\?|$)/.test(path)) {
        count++;
        if (!seen) {
          try {
            const body = JSON.parse(raw) as CapturedBody;
            // Claude Code also sends side requests (a session title, for one); only the main one counts.
            if (isMain(body)) {
              seen = true;
              resolveFirst({ body, path });
            }
          } catch {
            /* a body that is not JSON is simply never captured */
          }
        }
      }
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'regression capture: nothing forwarded' } }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}`, first, count: () => count };
}

/**
 * Starts one real Claude Code run against the capture server and returns the first request it sends.
 * The run is aborted as soon as that request has arrived. `captureConfig` must hold the dummy token.
 */
export async function captureRequest(
  translated: TranslatedRequest,
  plan: RoutePlan,
  captureConfig: Config,
  options: { timeoutMs?: number; verbatim?: boolean } = {},
): Promise<Captured> {
  if (captureConfig.secrets.claudeToken !== DUMMY_TOKEN) {
    throw new Error('capture needs the dummy-token config; refusing to run with a real token');
  }
  // The main request is the one that carries Forkline's own system prompt.
  const marker = translated.systemPrompt[0]?.slice(0, 40) ?? '';
  const cap = await startCaptureServer((body) => systemBlocks(body).some((block) => block.includes(marker)));
  const abort = new AbortController();
  const queryOptions = buildQueryOptions(translated, plan, captureConfig, abort);
  const env = { ...(queryOptions.env as Record<string, string>) };
  if (env[CLAUDE_ENV.oauthToken] !== DUMMY_TOKEN) throw new Error('capture env does not carry the dummy token');
  env.ANTHROPIC_BASE_URL = cap.baseUrl;
  queryOptions.env = env;
  if (options.verbatim === false) queryOptions.verbatimPrompts = false;

  const q = query({ prompt: buildPrompt(translated.livePrompt), options: queryOptions });
  const drain = (async (): Promise<void> => {
    try {
      for await (const message of q as AsyncIterable<SDKMessage>) void message;
    } catch {
      /* the 400 and the abort both end the iterator with an error */
    }
  })();
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error('no request reached the capture server')), options.timeoutMs ?? 45_000);
    timer.unref();
  });
  try {
    const first = await Promise.race([cap.first, timeout, drain.then(() => cap.first)]);
    return { ...first, requestCount: cap.count() };
  } finally {
    abort.abort();
    q.close();
    await Promise.race([drain, new Promise((resolve) => setTimeout(resolve, 5000))]);
    await new Promise<void>((resolve) => cap.server.close(() => resolve()));
  }
}
