// STUB. Task 2 replaces this file.
import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import type { HistoryItem } from '../types.js';

export interface EntryContext {
  sessionId: string;
  /** Model named on synthesized assistant entries. */
  model: string;
  newUuid: () => string;
  /** ISO 8601 timestamp. */
  now: () => string;
}

/** Turns history into chained transcript entries (RN section 4). Pure given `ctx`. */
export function buildEntries(_history: HistoryItem[], _ctx: EntryContext): SessionStoreEntry[] {
  return [];
}
