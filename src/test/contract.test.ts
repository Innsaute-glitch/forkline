import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADJUSTMENT, HANDLED_FIELDS } from '../constants.js';
import { bridgeError, STATUS_BY_CODE, toErrorBody } from '../errors.js';
import type { ChatRequest, RunEvent, TranslatedRequest } from '../types.js';
import { fixturePath, readFixture, readFixtureText } from './helpers.js';

const names = (dir: string) =>
  readdirSync(fixturePath(dir)).map((file) => file.replace(/\.[^.]+$/, ''));

describe('fixtures', () => {
  it('pairs every request fixture with a golden translation', () => {
    const requests = names('requests').filter((name) => name !== 'rejects');
    expect(requests.sort()).toEqual(names('golden/translated').sort());
  });

  it('keeps golden translations valid', () => {
    for (const name of names('golden/translated')) {
      const value = readFixture<TranslatedRequest>(`golden/translated/${name}.json`);
      const request = readFixture<ChatRequest>(`requests/${name}.json`);
      expect(value.livePrompt.role).toBe('user');
      expect(value.adjustments).toEqual([...new Set(value.adjustments)].sort());
      expect(value.adjustments).toContain(ADJUSTMENT.systemHeaderAdded);
      for (const field of Object.keys(request)) {
        if (!HANDLED_FIELDS.includes(field)) expect(value.adjustments).toContain(`${field}-ignored`);
      }
    }
  });

  it('keeps run-event sequences within the runner contract', () => {
    for (const name of names('run-events')) {
      const events = readFixture<RunEvent[]>(`run-events/${name}.json`);
      expect(['started', 'error']).toContain(events[0]?.type);
      const terminal = events.filter((event) => event.type === 'finished' || event.type === 'error');
      expect(terminal).toHaveLength(1);
      expect(events.at(-1)).toBe(terminal[0]);
    }
  });

  it('ends golden SSE with the DONE frame', () => {
    for (const name of names('golden/sse')) {
      expect(readFixtureText(`golden/sse/${name}.sse`).endsWith('data: [DONE]\n\n')).toBe(true);
    }
  });
});

describe('errors', () => {
  it('builds the wire error shape', () => {
    const error = bridgeError('usage-limit', 'Usage limit reached', 3600);
    expect(error).toEqual({ code: 'usage-limit', status: 429, message: 'Usage limit reached', retryAfterSeconds: 3600 });
    expect(toErrorBody(error)).toEqual({ error: { message: 'Usage limit reached', type: 'usage-limit', code: 429 } });
  });

  it('gives every code a status', () => {
    for (const status of Object.values(STATUS_BY_CODE)) expect(status).toBeGreaterThanOrEqual(400);
  });
});
