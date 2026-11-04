import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixturePath, readFixture } from '../../test/helpers.js';
import type { HistoryItem, TranslatedRequest } from '../../types.js';
import { buildEntries, toContent, type EntryContext } from '../index.js';

function ctx(): EntryContext {
  let n = 0;
  return {
    sessionId: 'sid-1',
    model: 'claude-sonnet-5-5',
    newUuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    now: () => '2026-11-04T06:00:00.000Z',
  };
}

describe('buildEntries', () => {
  it('returns nothing for an empty history', () => {
    expect(buildEntries([], ctx())).toEqual([]);
  });

  it('builds user, assistant and system entries from the RN section 4 templates', () => {
    const history: HistoryItem[] = [
      { role: 'assistant', content: 'Greeting.' },
      { role: 'user', content: 'Hello' },
      { role: 'system', content: "Author's note" },
    ];
    const [a, u, s] = buildEntries(history, ctx());
    expect(a).toEqual({
      parentUuid: null,
      uuid: '00000000-0000-4000-8000-000000000001',
      timestamp: '2026-11-04T06:00:00.000Z',
      sessionId: 'sid-1',
      type: 'assistant',
      message: {
        id: 'msg_00000000000040008000000000000001',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content: [{ type: 'text', text: 'Greeting.' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    expect(u).toMatchObject({ type: 'user', parentUuid: a?.uuid, message: { role: 'user', content: 'Hello' } });
    expect(s).toEqual({
      parentUuid: u?.uuid,
      uuid: '00000000-0000-4000-8000-000000000003',
      timestamp: '2026-11-04T06:00:00.000Z',
      sessionId: 'sid-1',
      type: 'attachment',
      attachment: { type: 'session_context', context: {} },
      rendered: [{ content: "Author's note" }],
      renderedRole: 'system',
    });
  });

  it('keeps consecutive same-role messages and empty replies as separate entries', () => {
    const entries = buildEntries(
      [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
        { role: 'assistant', content: '' },
      ],
      ctx(),
    );
    expect(entries.map((e) => e.type)).toEqual(['user', 'user', 'assistant']);
    expect((entries[2]?.message as { content: unknown }).content).toEqual([{ type: 'text', text: '' }]);
  });

  it('turns array content into blocks, with images as base64 sources', () => {
    const [entry] = buildEntries(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ],
      ctx(),
    );
    expect((entry?.message as { content: unknown }).content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
  });

  it('throws on an image that is not a data URL (programmer error)', () => {
    expect(() => toContent([{ type: 'image_url', image_url: { url: 'https://x/y.png' } }])).toThrow();
  });

  it('chains every golden history', () => {
    const names = readdirSync(fixturePath('golden/translated')).map((f) => f.replace('.json', ''));
    for (const name of names) {
      const t = readFixture<TranslatedRequest>(`golden/translated/${name}.json`);
      const entries = buildEntries(t.history, ctx());
      expect(entries).toHaveLength(t.history.length);
      entries.forEach((entry, i) => {
        expect(entry.parentUuid).toBe(i === 0 ? null : entries[i - 1]?.uuid);
        expect(entry.sessionId).toBe('sid-1');
      });
    }
  });
});
