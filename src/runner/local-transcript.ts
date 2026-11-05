// A new session (case A) leaves its transcript under <configDir>/projects, in plain text. Resumed
// sessions run from a temporary claude-resume-* folder, which the SDK removes once the subprocess
// exits, so it stays behind if Forkline dies first. Forkline keeps no chats, so these go too.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/**
 * Removes resume folders left by this server's runs, and only those: other programs on the machine
 * use the same folder names. Only safe while no run is active, so only at startup.
 */
export function removeStaleResumeFolders(workDir: string, tempDir = tmpdir()): void {
  const project = workDir.replace(/[^a-zA-Z0-9]/g, '-');
  for (const name of readdirSync(tempDir)) {
    if (!name.startsWith('claude-resume-')) continue;
    const folder = join(tempDir, name);
    if (existsSync(join(folder, 'projects', project))) rmSync(folder, { recursive: true, force: true });
  }
}
