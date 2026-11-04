// Shared contract types (plan.md section 3.1). Only the orchestrator edits this file.
import type { SessionStore } from '@anthropic-ai/claude-agent-sdk';

// ---- OpenAI request, as the client sends it ----

export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

export type MessageContent = string | OpenAIContentPart[];

export interface OpenAIMessage {
  role: string;
  content?: MessageContent | null;
  tool_calls?: unknown;
  reasoning_content?: unknown;
  reasoning_details?: unknown;
  [key: string]: unknown;
}

export interface ChatRequest {
  model?: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  [key: string]: unknown;
}

// ---- Translator output ----

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** One history message. `content` is exactly what the client sent. */
export interface HistoryItem {
  role: 'user' | 'assistant' | 'system';
  content: MessageContent;
}

export interface RequestParams {
  stream: boolean;
  effort: EffortLevel;
  /** Value for CLAUDE_CODE_MAX_OUTPUT_TOKENS; null leaves it unset. */
  maxOutputTokens: number | null;
  /** Stop strings, non-empty ones only; [] means none. */
  stop: string[];
  /** False only when the client sent stream_options.include_usage: false. */
  includeUsage: boolean;
}

export interface TranslatedRequest {
  /** `model` field echoed in responses: the client's value, else the configured default id. */
  responseModel: string;
  /** Full Claude model id handed to the SDK. */
  claudeModel: string;
  /** [systemHeader, ...leading system texts]. */
  systemPrompt: string[];
  /** Everything before the live prompt, in final order (D10 move already applied). */
  history: HistoryItem[];
  livePrompt: HistoryItem & { role: 'user' };
  params: RequestParams;
  /** De-duplicated, sorted ascending. */
  adjustments: string[];
}

export type TranslateResult =
  | { ok: true; value: TranslatedRequest }
  | { ok: false; error: BridgeErrorInfo };

// ---- Errors ----

export type BridgeErrorCode =
  | 'invalid-request' // 400 translator rejections
  | 'adjustment-rejected' // 400 config adjustments: "reject"
  | 'intercepted-command' // 400 live prompt was a Claude Code command
  | 'upstream-invalid-request' // 400 API 400, Claude's message passed on
  | 'context-too-long' // 400
  | 'output-limit' // 400 "reply exceeded max_tokens"
  | 'unauthorized' // 401 bad or missing bearer key
  | 'not-found' // 404
  | 'body-too-large' // 413
  | 'usage-limit' // 429, retryAfterSeconds when known
  | 'auth-failed' // 502 "Claude Code is not signed in"
  | 'model-mismatch' // 502 model guard
  | 'session-stale' // 502 internal: reroute to D before any output
  | 'upstream' // 502 anything else
  | 'queue-full' // 503
  | 'timeout'; // 504

export interface BridgeErrorInfo {
  code: BridgeErrorCode;
  status: number;
  message: string;
  retryAfterSeconds?: number;
}

/** Wire shape for HTTP error bodies and the in-stream error chunk. */
export interface ErrorBody {
  error: { message: string; type: BridgeErrorCode; code: number };
}

// ---- Router ----

export type RouteCase = 'A' | 'B' | 'C' | 'D';

export interface RoutePlan {
  case: RouteCase;
  /** Session the transcript lands in: seeded id for D, stored id for B, new id for A and C. */
  sessionId: string;
  sessionStore: SessionStore;
  /** SDK `resume`. Unset for A. */
  resume?: string;
  forkSession?: boolean;
  resumeSessionAt?: string;
  /** Per-session lock key. null in v0. */
  lockKey: string | null;
}

export interface RouteOptions {
  /** Skip the index and rebuild, used after `session-stale`. */
  forceRebuild?: boolean;
}

export interface RouteRecord {
  translated: TranslatedRequest;
  plan: RoutePlan;
  /** Exact visible text returned to the client. */
  replyText: string;
}

export interface Router {
  route(translated: TranslatedRequest, options?: RouteOptions): Promise<RoutePlan>;
  /** Called only after `finished` with finishReason 'stop', no stop match and no disconnect. */
  record(record: RouteRecord): Promise<void>;
  close(): void;
}

// ---- Runner ----

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type FinishReason = 'stop' | 'length' | 'content_filter';

/**
 * The first event is always `started` or `error`.
 * Every run ends with exactly one `finished` or `error`, unless its signal
 * aborts: an aborted run ends with no terminal event.
 * `started` means the model was really called (first stream_event).
 */
export type RunEvent =
  | { type: 'started'; sessionId: string; model: string }
  | { type: 'reasoning'; text: string }
  | { type: 'text'; text: string }
  | { type: 'finished'; sessionId: string; finishReason: FinishReason; usage: TokenUsage }
  | { type: 'error'; error: BridgeErrorInfo };

export interface RateLimitWindow {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  /** Passed through from the SDK unchanged. */
  utilization: number | null;
  /** Passed through from the SDK unchanged. */
  resetsAt: number | null;
  /** ISO 8601 time this window was last updated. */
  updatedAt: string;
}

/** Keyed by the SDK's rateLimitType, e.g. five_hour, seven_day. */
export type RateLimitSnapshot = Record<string, RateLimitWindow>;

// ---- Stream mapper ----

export interface StreamResult {
  replyText: string;
  reasoningText: string;
  /** True when a stop string ended the reply. */
  stopMatched: boolean;
  finishReason: FinishReason | null;
  usage: TokenUsage | null;
  error: BridgeErrorInfo | null;
}

export interface StreamContext {
  /** `chatcmpl-<uuid>` */
  id: string;
  /** Unix seconds. */
  created: number;
  model: string;
  stop: string[];
  includeUsage: boolean;
  /** Called once when a stop string matches, so the caller can abort the run. */
  onStopMatched: () => void;
  /** Called once when the response is complete. */
  onDone: (result: StreamResult) => void;
}

export interface WireUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details: { cached_tokens: number };
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: [
    {
      index: 0;
      message: { role: 'assistant'; content: string; reasoning_content?: string };
      finish_reason: FinishReason;
    },
  ];
  usage?: WireUsage;
}

export type CompletionResult =
  | { ok: true; body: ChatCompletion }
  | { ok: false; error: BridgeErrorInfo };
