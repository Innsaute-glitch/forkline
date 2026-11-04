// The Claude Code subprocess environment: an allow-list. The SDK's `env` option replaces the
// environment rather than merging it, so nothing else (no FORKLINE_*, no ANTHROPIC_*) gets through.
import type { Config } from '../config.js';
import { CLAUDE_ENV, PASSTHROUGH_ENV } from '../constants.js';
import type { TranslatedRequest } from '../types.js';

export function buildSubprocessEnv(
  config: Config,
  translated: TranslatedRequest,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSTHROUGH_ENV) {
    const value = parentEnv[name];
    if (value !== undefined) env[name] = value;
  }
  env[CLAUDE_ENV.oauthToken] = config.secrets.claudeToken;
  env[CLAUDE_ENV.configDir] = config.paths.configDir;
  env[CLAUDE_ENV.disableAutoUpdater] = '1';
  env[CLAUDE_ENV.disableAttachments] = '1';
  env[CLAUDE_ENV.claudeAiMcp] = 'false';
  env[CLAUDE_ENV.disableCompact] = '1';
  if (translated.params.maxOutputTokens !== null) {
    env[CLAUDE_ENV.maxOutputTokens] = String(translated.params.maxOutputTokens);
  }
  return env;
}
