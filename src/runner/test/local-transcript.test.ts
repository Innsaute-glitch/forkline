import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeAllLocalTranscripts, removeLocalTranscript } from '../local-transcript.js';

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

  it('accepts a config folder with no transcripts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forkline-transcript-'));
    expect(() => removeLocalTranscript(dir, 'one')).not.toThrow();
    expect(() => removeAllLocalTranscripts(dir)).not.toThrow();
  });
});
