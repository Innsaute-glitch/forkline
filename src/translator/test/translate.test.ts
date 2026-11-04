import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADJUSTMENT, DEFAULT_SYSTEM_HEADER } from '../../constants.js';
import type { ChatRequest, TranslatedRequest } from '../../types.js';
import { fixturePath, goldenConfig, readFixture } from '../../test/helpers.js';
import { translate } from '../index.js';

const names = readdirSync(fixturePath('requests'))
  .map((file) => file.replace(/\.json$/, ''))
  .filter((name) => name !== 'rejects');

describe('golden translations', () => {
  it('finds the fixtures', () => {
    expect(names.length).toBeGreaterThanOrEqual(10);
  });

  it.each(names)('%s deep-equals its golden file', (name) => {
    const result = translate(readFixture<ChatRequest>(`requests/${name}.json`), goldenConfig());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(readFixture<TranslatedRequest>(`golden/translated/${name}.json`));
  });

  it('starts every system prompt with the default header', () => {
    const result = translate(readFixture<ChatRequest>('requests/first-message-plain.json'), goldenConfig());
    expect(result.ok && result.value.systemPrompt[0]).toBe(DEFAULT_SYSTEM_HEADER);
  });

  it('does not change or alias the request', () => {
    const request = readFixture<ChatRequest>('requests/image.json');
    const copy = structuredClone(request);
    const result = translate(request, goldenConfig());
    expect(request).toEqual(copy);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.history[0]!.content).not.toBe(request.messages[3]!.content);
  });
});

interface RejectCase {
  name: string;
  request: ChatRequest;
  status: number;
}

describe('rejects.json', () => {
  const cases = readFixture<RejectCase[]>('requests/rejects.json');

  it('has cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s returns its status', (_name, c) => {
    const result = translate(c.request, goldenConfig());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(c.status);
    expect(result.error.code).toBe('invalid-request');
  });

  it('never puts message text or image data in an error message', () => {
    for (const c of cases) {
      const result = translate(c.request, goldenConfig());
      if (result.ok) continue;
      expect(result.error.message).not.toContain('narrator');
      expect(result.error.message).not.toContain('example.com');
    }
  });
});

describe('adjustments: "reject"', () => {
  const rejectConfig = () => ({ ...goldenConfig(), adjustments: 'reject' as const });
  const clean = (): ChatRequest => ({
    model: 'claude-haiku-5-5',
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hi' },
    ],
  });

  it('allows a request whose only adjustment is system-header-added', () => {
    const result = translate(clean(), rejectConfig());
    expect(result.ok && result.value.adjustments).toEqual([ADJUSTMENT.systemHeaderAdded]);
  });

  it('rejects every fixture that needs other adjustments, with adjustment-rejected 400', () => {
    for (const name of names) {
      const result = translate(readFixture<ChatRequest>(`requests/${name}.json`), rejectConfig());
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('adjustment-rejected');
      expect(result.error.status).toBe(400);
    }
  });

  it('names the offending adjustments but not the exempt one', () => {
    const result = translate({ ...clean(), temperature: 0.5 }, rejectConfig());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('temperature-ignored');
    expect(result.error.message).not.toContain('system-header-added');
  });

  it('still returns invalid-request for a broken request', () => {
    const result = translate({ messages: [] }, rejectConfig());
    expect(result.ok || result.error.code).toBe('invalid-request');
  });

  it('does not reject in report mode', () => {
    expect(translate({ ...clean(), temperature: 0.5 }, goldenConfig()).ok).toBe(true);
  });
});
