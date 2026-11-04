// Pure builders for the SDK call (brief section 7 and the per-case table in plan.md section 3.1).
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from '../config.js';
import { toContent } from '../transcript/index.js';
import type { HistoryItem, RoutePlan, TranslatedRequest } from '../types.js';
import { buildSubprocessEnv } from './env.js';

/**
 * Options for one run. `sessionId` goes only to A and C: the SDK rejects it together with
 * `resume` unless `forkSession` is set. `fallbackModel` is never set.
 */
export function buildQueryOptions(
  translated: TranslatedRequest,
  plan: RoutePlan,
  config: Config,
  abortController: AbortController,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Options {
  const options: Options = {
    cwd: config.paths.workDir,
    model: translated.claudeModel,
    systemPrompt: { type: 'custom', prompt: translated.systemPrompt, snapshot: false },
    tools: [],
    skills: [],
    settingSources: [],
    mcpServers: {},
    strictMcpConfig: true,
    // Live text reaches the model as written: no slash-command dispatch, no @path expansion.
    verbatimPrompts: true,
    maxTurns: 1,
    permissionMode: 'dontAsk',
    thinking: { type: 'adaptive', display: config.thinkingDisplay },
    effort: translated.params.effort,
    includePartialMessages: true,
    sessionStore: plan.sessionStore,
    abortController,
    env: buildSubprocessEnv(config, translated, parentEnv),
  };
  switch (plan.case) {
    case 'A':
      options.sessionId = plan.sessionId;
      break;
    case 'B':
    case 'D':
      options.resume = requireResume(plan);
      break;
    case 'C':
      options.resume = requireResume(plan);
      options.sessionId = plan.sessionId;
      options.forkSession = true;
      if (plan.resumeSessionAt !== undefined) options.resumeSessionAt = plan.resumeSessionAt;
      break;
  }
  return options;
}

function requireResume(plan: RoutePlan): string {
  if (!plan.resume) throw new Error(`route plan for case ${plan.case} has no resume session`);
  return plan.resume;
}

/** A string for text, or a one-message iterable when the content is an array (images). */
export function buildPrompt(livePrompt: HistoryItem): string | AsyncIterable<SDKUserMessage> {
  const content = toContent(livePrompt.content);
  if (typeof content === 'string') return content;
  return (async function* oneMessage(): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
  })();
}
