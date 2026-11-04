import { ADJUSTMENT } from '../constants.js';
import { bridgeError } from '../errors.js';
import type { BridgeErrorInfo, HistoryItem, MessageContent, OpenAIContentPart } from '../types.js';

export type Result<T> = { ok: true; value: T } | { ok: false; error: BridgeErrorInfo };

const fail = (message: string): { ok: false; error: BridgeErrorInfo } => ({
  ok: false,
  error: bridgeError('invalid-request', message),
});

const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface NormalizedMessage {
  role: 'user' | 'assistant' | 'system';
  content: MessageContent;
  /** User messages only: no non-whitespace text and no image. */
  blank: boolean;
  /** Assistant messages only: carries reasoning_content or reasoning_details. */
  hasReasoning: boolean;
}

/** Text of a system or assistant message. Image parts are not allowed there. */
function normalizeTextContent(
  content: unknown,
  role: string,
  index: number,
): Result<string> {
  if (content === undefined || content === null) return { ok: true, value: '' };
  if (typeof content === 'string') return { ok: true, value: content };
  if (!Array.isArray(content)) return fail(`messages[${index}].content must be a string or an array`);
  let text = '';
  for (const part of content) {
    if (!isRecord(part)) return fail(`messages[${index}].content has a part that is not an object`);
    if (part.type === 'image_url') {
      return fail(`images are only allowed in user messages (messages[${index}] is ${role})`);
    }
    if (part.type !== 'text' || typeof part.text !== 'string') {
      return fail(`messages[${index}].content has an unsupported part`);
    }
    text += part.text;
  }
  return { ok: true, value: text };
}

/** Content of a user message, exactly as sent, plus whether it is blank. */
function normalizeUserContent(
  content: unknown,
  index: number,
): Result<{ content: MessageContent; blank: boolean }> {
  if (content === undefined || content === null) {
    return { ok: true, value: { content: '', blank: true } };
  }
  if (typeof content === 'string') {
    return { ok: true, value: { content, blank: content.trim().length === 0 } };
  }
  if (!Array.isArray(content)) return fail(`messages[${index}].content must be a string or an array`);
  let hasText = false;
  let hasImage = false;
  for (const part of content) {
    if (!isRecord(part)) return fail(`messages[${index}].content has a part that is not an object`);
    if (part.type === 'text' && typeof part.text === 'string') {
      if (part.text.trim().length > 0) hasText = true;
    } else if (part.type === 'image_url') {
      const image = part.image_url;
      const url = isRecord(image) ? image.url : undefined;
      if (typeof url !== 'string' || !IMAGE_DATA_URL.test(url)) {
        return fail(
          `messages[${index}] has an image that is not a base64 data: URL of png, jpeg, gif or webp; remote URLs are never fetched`,
        );
      }
      hasImage = true;
    } else {
      return fail(`messages[${index}].content has an unsupported part`);
    }
  }
  return {
    value: { content: structuredClone(content) as OpenAIContentPart[], blank: !hasText && !hasImage },
    ok: true,
  };
}

function normalizeMessage(raw: unknown, index: number): Result<NormalizedMessage> {
  if (!isRecord(raw)) return fail(`messages[${index}] must be an object`);
  const role = raw.role;
  if (role !== 'system' && role !== 'user' && role !== 'assistant') {
    return fail(
      `messages[${index}] has unsupported role ${typeof role === 'string' ? `"${role}"` : '(not a string)'}; only system, user and assistant are accepted`,
    );
  }
  const toolCalls = raw.tool_calls;
  if (toolCalls !== undefined && toolCalls !== null && !(Array.isArray(toolCalls) && toolCalls.length === 0)) {
    return fail(`messages[${index}] has tool_calls; tools are not supported`);
  }
  if (role === 'user') {
    const user = normalizeUserContent(raw.content, index);
    if (!user.ok) return user;
    return { ok: true, value: { role, ...user.value, hasReasoning: false } };
  }
  const text = normalizeTextContent(raw.content, role, index);
  if (!text.ok) return text;
  const hasReasoning =
    role === 'assistant' &&
    ((raw.reasoning_content !== undefined && raw.reasoning_content !== null) ||
      (raw.reasoning_details !== undefined && raw.reasoning_details !== null));
  return { ok: true, value: { role, content: text.value, blank: false, hasReasoning } };
}

/** A history system entry of spaces only makes the API return 400. An empty one is fine. */
const isWhitespaceSystem = (message: NormalizedMessage): boolean =>
  message.role === 'system' &&
  typeof message.content === 'string' &&
  message.content.length > 0 &&
  message.content.trim().length === 0;

export interface SplitMessages {
  /** Leading system texts, in order (the header is added by the caller). */
  systemTexts: string[];
  history: HistoryItem[];
  livePrompt: HistoryItem & { role: 'user' };
  adjustments: string[];
}

/** Validates and splits `messages` into system prompt, history and live prompt. */
export function splitMessages(raw: unknown): Result<SplitMessages> {
  if (!Array.isArray(raw) || raw.length === 0) return fail('messages must be a non-empty array');

  const messages: NormalizedMessage[] = [];
  for (let i = 0; i < raw.length; i++) {
    const normalized = normalizeMessage(raw[i], i);
    if (!normalized.ok) return normalized;
    messages.push(normalized.value);
  }

  let firstNonSystem = 0;
  while (firstNonSystem < messages.length && messages[firstNonSystem]!.role === 'system') {
    firstNonSystem++;
  }

  let liveIndex = -1;
  for (let i = messages.length - 1; i >= firstNonSystem; i--) {
    if (messages[i]!.role === 'user') {
      liveIndex = i;
      break;
    }
  }
  if (liveIndex === -1) {
    return fail('messages must contain a user message after the system messages');
  }
  const trailing = messages.slice(liveIndex + 1);
  if (trailing.some((message) => message.role !== 'system')) {
    return fail('only system messages may come after the last user message (assistant prefill is not supported)');
  }
  const live = messages[liveIndex]!;
  if (live.blank) return fail('the last user message is blank');

  const adjustments = new Set<string>();
  const history: HistoryItem[] = [];
  for (const message of messages.slice(firstNonSystem, liveIndex)) {
    if (message.role === 'user' && message.blank) {
      adjustments.add(ADJUSTMENT.blankUserDropped);
      continue;
    }
    if (isWhitespaceSystem(message)) {
      adjustments.add(ADJUSTMENT.blankSystemDropped);
      continue;
    }
    if (message.hasReasoning) adjustments.add(ADJUSTMENT.reasoningReplayIgnored);
    history.push({ role: message.role, content: message.content });
  }
  if (trailing.length > 0) {
    adjustments.add(ADJUSTMENT.trailingSystemMoved);
    for (const message of trailing) {
      if (isWhitespaceSystem(message)) adjustments.add(ADJUSTMENT.blankSystemDropped);
      else history.push({ role: 'system', content: message.content });
    }
  }

  return {
    ok: true,
    value: {
      systemTexts: messages.slice(0, firstNonSystem).map((message) => message.content as string),
      history,
      livePrompt: { role: 'user', content: live.content },
      adjustments: [...adjustments],
    },
  };
}
