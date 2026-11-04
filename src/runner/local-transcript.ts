// A new session (case A) leaves its transcript under <configDir>/projects, in plain text. Resumed
// sessions run from a temporary folder Claude Code removes itself. Forkline keeps no chats, so
// these files go as soon as the run ends.
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Removes one session's local files. A missing folder or file is fine. */
export function removeLocalTranscript(configDir: string, sessionId: string): void {
  const projects = join(configDir, 'projects');
  let folders: string[];
  try {
    folders = readdirSync(projects);
  } catch {
    return;
  }
  for (const folder of folders) {
    rmSync(join(projects, folder, `${sessionId}.jsonl`), { force: true });
    rmSync(join(projects, folder, sessionId), { recursive: true, force: true });
  }
}

/** Removes every local transcript. Only safe while no run is active, so only at startup. */
export function removeAllLocalTranscripts(configDir: string): void {
  rmSync(join(configDir, 'projects'), { recursive: true, force: true });
}
