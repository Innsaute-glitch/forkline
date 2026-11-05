// Transcript entries for rebuilt history (case D).
import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { INJECTED_TEXT_FILLER } from '../constants.js';
import type { HistoryItem, MessageContent } from '../types.js';

export interface EntryContext {
  sessionId: string;
  /** Model named on synthesized assistant entries. */
  model: string;
  newUuid: () => string;
  /** ISO 8601 timestamp. */
  now: () => string;
}

/** Anthropic content block, as written in a transcript or a streamed user message. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } };

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

/** OpenAI content parts to Anthropic blocks. A string stays a string. Programmer error on a bad image URL. */
export function toContent(content: MessageContent): string | ContentBlock[] {
  if (typeof content === 'string') return content;
  return content.map((part): ContentBlock => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    const match = DATA_URL.exec(part.image_url.url);
    if (!match) throw new Error('image_url is not a base64 data URL; the translator should have rejected it');
    return { type: 'image', source: { type: 'base64', media_type: match[1] as ImageMediaType, data: match[2] as string } };
  });
}

/** Assistant history is text: a string, or text parts joined (the translator already joined arrays). */
function assistantText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

function systemText(content: MessageContent): string {
  return assistantText(content);
}

/** Turns history into chained transcript entries. Pure given `ctx`. */
export function buildEntries(history: HistoryItem[], ctx: EntryContext): SessionStoreEntry[] {
  const entries: SessionStoreEntry[] = [];
  let parentUuid: string | null = null;
  for (const item of history) {
    const uuid = ctx.newUuid();
    const timestamp = ctx.now();
    const base = { parentUuid, uuid, timestamp, sessionId: ctx.sessionId };
    if (item.role === 'user') {
      entries.push({ ...base, type: 'user', message: { role: 'user', content: toContent(item.content) } });
    } else if (item.role === 'assistant') {
      entries.push({
        ...base,
        type: 'assistant',
        message: {
          id: `msg_${uuid.replaceAll('-', '')}`,
          type: 'message',
          role: 'assistant',
          model: ctx.model,
          content: [{ type: 'text', text: assistantText(item.content) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    } else {
      // A system message inside the conversation becomes a real system message in the request.
      // `session_context`, not `date`: a seeded `date` attachment makes Claude Code compare it with
      // today, then either announce a changed date or drop its own date line.
      entries.push({
        ...base,
        type: 'attachment',
        attachment: { type: 'session_context', context: {} },
        rendered: [{ content: systemText(item.content) }],
        renderedRole: 'system',
      });
    }
    parentUuid = uuid;
  }
  return entries;
}

/** What Claude Code would report itself. It compares these exactly before skipping its own text. */
export interface SeedFacts {
  workDir: string;
  platform: string;
  shell: string;
  osVersion: string;
  /** Local date, YYYY-MM-DD. */
  today: string;
  /** Null leaves Claude Code's model line in the request. */
  identity: { modelId: string; marketingName: string; knowledgeCutoff: string } | null;
}

/**
 * Entries that make Claude Code treat its environment, model and date text as already sent, with
 * filler rendered in its place. Goes after the history, chained from `parentUuid`.
 */
export function buildSeedEntries(
  parentUuid: string | null,
  facts: SeedFacts,
  ctx: EntryContext,
): SessionStoreEntry[] {
  const attachments: Record<string, unknown>[] = [
    {
      type: 'environment',
      snapshot: {
        workingDirectory: facts.workDir,
        isWorktree: false,
        isGitRepo: false,
        additionalWorkingDirectories: [],
        platform: facts.platform,
        shell: facts.shell,
        osVersion: facts.osVersion,
      },
    },
  ];
  if (facts.identity) attachments.push({ type: 'model', identity: facts.identity });
  attachments.push({ type: 'date', date: facts.today });

  const entries: SessionStoreEntry[] = [];
  let parent = parentUuid;
  for (const attachment of attachments) {
    const uuid = ctx.newUuid();
    entries.push({
      parentUuid: parent,
      uuid,
      timestamp: ctx.now(),
      sessionId: ctx.sessionId,
      type: 'attachment',
      attachment,
      rendered: [{ content: INJECTED_TEXT_FILLER }],
      renderedRole: 'system',
    });
    parent = uuid;
  }
  return entries;
}
