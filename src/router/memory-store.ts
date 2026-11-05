// Per-request in-memory SessionStore. Forkline keeps no sessions.
import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';

/**
 * Follows the store rules in plan.md section 3.1: keyed on `sessionId` only, entries kept in
 * call order, de-duplicated by `uuid` when present, always appended when there is no `uuid`,
 * and a `subpath` key (subagents) is a no-op on append and null on load.
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, { entries: SessionStoreEntry[]; uuids: Set<string> }>();

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (key.subpath) return;
    let session = this.sessions.get(key.sessionId);
    if (!session) {
      session = { entries: [], uuids: new Set() };
      this.sessions.set(key.sessionId, session);
    }
    for (const entry of entries) {
      if (entry.uuid !== undefined) {
        if (session.uuids.has(entry.uuid)) continue;
        session.uuids.add(entry.uuid);
      }
      session.entries.push(entry);
    }
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    if (key.subpath) return null;
    const session = this.sessions.get(key.sessionId);
    return session ? [...session.entries] : null;
  }
}
