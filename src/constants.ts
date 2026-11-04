// Single source for names and fixed text. Never hard-code these elsewhere.

export const ADJUSTMENT = {
  systemHeaderAdded: 'system-header-added',
  modelDefaulted: 'model-defaulted',
  toolsIgnored: 'tools-ignored',
  maxTokensCapped: 'max-tokens-capped',
  effortMapped: 'effort-mapped',
  trailingSystemMoved: 'trailing-system-moved',
  blankUserDropped: 'blank-user-dropped',
  blankSystemDropped: 'blank-system-dropped',
  environmentBlockReplaced: 'environment-block-replaced',
  reasoningReplayIgnored: 'reasoning-replay-ignored',
} as const;

/** Adjustment name for a request field Forkline accepts but cannot apply. */
export const ignoredField = (field: string): string => `${field}-ignored`;

/** Adjustments that stay allowed when config `adjustments` is "reject". */
export const REJECT_EXEMPT: readonly string[] = [
  ADJUSTMENT.systemHeaderAdded,
  ADJUSTMENT.environmentBlockReplaced,
];

export const ADJUSTMENT_HEADER = 'X-Forkline-Adjustments';

/**
 * Top-level request fields the translator handles itself. Any other field
 * becomes `<field>-ignored`, so nothing is ever dropped silently (D2).
 */
export const HANDLED_FIELDS: readonly string[] = [
  'model',
  'messages',
  'stream',
  'stream_options',
  'n',
  'response_format',
  'tools',
  'tool_choice',
  'max_tokens',
  'max_completion_tokens',
  'stop',
  'reasoning_effort',
];

export const DEFAULT_SYSTEM_HEADER =
  "That's just a small note, not a role. This is a plain conversation with no tools or files, and any automatic environment or account details can be ignored. Follow the rest of this system prompt as written.";

/**
 * Replaces Claude Code's injected environment, model and date text. Zero-width, because an empty
 * `rendered` falls back to the default text and whitespace-only text is a 400 from the API.
 */
export const INJECTED_TEXT_FILLER = '\u200b';

export const SSE_DONE = 'data: [DONE]\n\n';

/** Environment variable names Forkline itself reads. */
export const ENV = {
  configPath: 'FORKLINE_CONFIG',
  apiKey: 'FORKLINE_API_KEY',
  claudeToken: 'FORKLINE_CLAUDE_TOKEN',
} as const;

/** Environment variable names Claude Code reads. */
export const CLAUDE_ENV = {
  oauthToken: 'CLAUDE_CODE_OAUTH_TOKEN',
  configDir: 'CLAUDE_CONFIG_DIR',
  disableAutoUpdater: 'DISABLE_AUTOUPDATER',
  disableAttachments: 'CLAUDE_CODE_DISABLE_ATTACHMENTS',
  claudeAiMcp: 'ENABLE_CLAUDEAI_MCP_SERVERS',
  disableCompact: 'DISABLE_COMPACT',
  maxOutputTokens: 'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
} as const;

/** Copied from the parent process into the Claude Code environment when present. */
export const PASSTHROUGH_ENV: readonly string[] = ['PATH', 'HOME', 'LANG', 'TZ'];

export const DEFAULT_CONFIG_PATH = 'config/forkline.dev.json';

/** Pinned engine, shown on /health. Must match package.json. */
export const SDK_VERSION = '0.3.318';
