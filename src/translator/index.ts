// STUB. Task 1 replaces this file. Returns a fixture so other tasks can start.
import { readFileSync } from 'node:fs';
import type { Config } from '../config.js';
import type { ChatRequest, TranslatedRequest, TranslateResult } from '../types.js';

export function translate(_request: ChatRequest, _config: Config): TranslateResult {
  const url = new URL('../../fixtures/golden/translated/greeting-lorebook.json', import.meta.url);
  const value = JSON.parse(readFileSync(url, 'utf8')) as TranslatedRequest;
  return { ok: true, value };
}
