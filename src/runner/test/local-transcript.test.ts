import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeAllLocalTranscripts, removeLocalTranscript, removeStaleResumeFolders } from '../local-transcript.js';

function configDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forkline-transcript-'));
  mkdirSync(join(dir, 'projects', 'work', 'one', 'subagents'), { recursive: true });
  writeFileSync(join(dir, 'projects', 'work', 'one.jsonl'), '{}');
  writeFileSync(join(dir, 'projects', 'work', 'two.jsonl'), '{}');
  writeFileSync(join(dir, '.claude.json'), '{}');
  return dir;
}

describe('local transcripts', () => {
  it('removes one session and leaves the others', () => {
    const dir = configDir();
    removeLocalTranscript(dir, 'one');
    expect(existsSync(join(dir, 'projects', 'work', 'one.jsonl'))).toBe(false);
    expect(existsSync(join(dir, 'projects', 'work', 'one'))).toBe(false);
    expect(existsSync(join(dir, 'projects', 'work', 'two.jsonl'))).toBe(true);
  });

  it('removes all transcripts but keeps the config', () => {
    const dir = configDir();
    removeAllLocalTranscripts(dir);
    expect(existsSync(join(dir, 'projects'))).toBe(false);
    expect(existsSync(join(dir, '.claude.json'))).toBe(true);
  });

  it('removes only the resume folders of this work folder', () => {
    const temp = mkdtempSync(join(tmpdir(), 'forkline-temp-'));
    mkdirSync(join(temp, 'claude-resume-mine', 'projects', '-srv-forkline-work'), { recursive: true });
    mkdirSync(join(temp, 'claude-resume-other', 'projects', '-home-someone-else'), { recursive: true });
    mkdirSync(join(temp, 'unrelated', 'projects', '-srv-forkline-work'), { recursive: true });
    removeStaleResumeFolders('/srv/forkline/work', temp);
    expect(existsSync(join(temp, 'claude-resume-mine'))).toBe(false);
    expect(existsSync(join(temp, 'claude-resume-other'))).toBe(true);
    expect(existsSync(join(temp, 'unrelated'))).toBe(true);
  });

  it('accepts a config folder with no transcripts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forkline-transcript-'));
    expect(() => removeLocalTranscript(dir, 'one')).not.toThrow();
    expect(() => removeAllLocalTranscripts(dir)).not.toThrow();
  });
});
