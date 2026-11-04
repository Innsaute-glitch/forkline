import { describe, expect, it } from 'vitest';
import { StopScanner } from '../stop-scanner.js';

function scan(stops: string[], chunks: string[]): { text: string; matched: boolean; pieces: string[] } {
  const scanner = new StopScanner(stops);
  const pieces: string[] = [];
  let matched = false;
  for (const chunk of chunks) {
    const result = scanner.push(chunk);
    pieces.push(result.emit);
    if (result.matched) {
      matched = true;
      break;
    }
  }
  if (!matched) {
    const result = scanner.flush();
    pieces.push(result.emit);
    matched = result.matched;
  }
  return { text: pieces.join(''), matched, pieces };
}

/** Reference: whole string, earliest start of any stop. */
function reference(stops: string[], text: string): { text: string; matched: boolean } {
  let best = -1;
  for (const stop of stops.filter((s) => s.length > 0)) {
    const at = text.indexOf(stop);
    if (at !== -1 && (best === -1 || at < best)) best = at;
  }
  return best === -1 ? { text, matched: false } : { text: text.slice(0, best), matched: true };
}

// Small seeded PRNG so failures are reproducible.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomChunks(text: string, rand: () => number): string[] {
  const chunks: string[] = [];
  let at = 0;
  while (at < text.length) {
    const size = 1 + Math.floor(rand() * 5);
    chunks.push(text.slice(at, at + size));
    at += size;
  }
  return chunks;
}

describe('StopScanner', () => {
  it('passes text through when there are no stops', () => {
    const result = scan([], ['Hello ', 'world']);
    expect(result).toMatchObject({ text: 'Hello world', matched: false });
    expect(result.pieces).toEqual(['Hello ', 'world', '']);
  });

  it('ignores empty stop strings', () => {
    expect(scan([''], ['abc']).text).toBe('abc');
  });

  it('matches across the chunk boundary and keeps only the text before it', () => {
    const result = scan(['\nUser:'], ['Mira nods.\nUs', 'er: thanks', ' again']);
    expect(result.matched).toBe(true);
    expect(result.text).toBe('Mira nods.');
  });

  it('holds back (longest stop length - 1) units and releases the rest', () => {
    const scanner = new StopScanner(['abcd']);
    expect(scanner.push('xxxxxx')).toEqual({ emit: 'xxx', matched: false });
    expect(scanner.flush()).toEqual({ emit: 'xxx', matched: false });
  });

  it('releases the held tail when the run ends without a match', () => {
    const result = scan(['STOP'], ['hello ST']);
    expect(result).toMatchObject({ text: 'hello ST', matched: false });
  });

  it('earliest match wins across stops', () => {
    expect(scan(['two', 'one'], ['one two']).text).toBe('');
    expect(scan(['two', 'one'], ['x two one']).text).toBe('x ');
  });

  it('waits when a longer stop that started earlier could still complete', () => {
    // "c" matches at 2, but "abcd" starts earlier at 0 and wins if "d" follows.
    const split = scan(['abcd', 'c'], ['abc', 'd']);
    const whole = scan(['abcd', 'c'], ['abcd']);
    expect(split).toMatchObject({ text: '', matched: true });
    expect(whole).toMatchObject({ text: '', matched: true });
    // And when the longer one does not complete, the shorter match stands.
    expect(scan(['abcd', 'c'], ['abc', 'x'])).toMatchObject({ text: 'ab', matched: true });
  });

  it('commits a pending full match when the run ends', () => {
    expect(scan(['abcd', 'c'], ['abc'])).toMatchObject({ text: 'ab', matched: true });
  });

  it('ignores input after a match', () => {
    const scanner = new StopScanner(['X']);
    expect(scanner.push('aXb')).toEqual({ emit: 'a', matched: true });
    expect(scanner.push('more')).toEqual({ emit: '', matched: false });
    expect(scanner.flush()).toEqual({ emit: '', matched: false });
  });

  it('any chunking of one text gives the same result (property)', () => {
    const rand = mulberry32(12345);
    const alphabet = 'abc\n';
    for (let round = 0; round < 3000; round += 1) {
      const textLength = Math.floor(rand() * 24);
      let text = '';
      for (let i = 0; i < textLength; i += 1) text += alphabet[Math.floor(rand() * alphabet.length)];
      const stopCount = Math.floor(rand() * 4);
      const stops: string[] = [];
      for (let s = 0; s < stopCount; s += 1) {
        const length = 1 + Math.floor(rand() * 4);
        let stop = '';
        for (let i = 0; i < length; i += 1) stop += alphabet[Math.floor(rand() * alphabet.length)];
        stops.push(stop);
      }
      const expected = reference(stops, text);
      const chunked = scan(stops, randomChunks(text, rand));
      const whole = scan(stops, [text]);
      const context = JSON.stringify({ text, stops });
      expect({ ...pick(chunked), context }).toEqual({ ...expected, context });
      expect({ ...pick(whole), context }).toEqual({ ...expected, context });
    }
  });

  it('never splits a surrogate pair across released chunks', () => {
    const emoji = '\u{1F600}';
    const text = `a${emoji}b${emoji}${emoji}c`;
    for (const stops of [[], ['zz'], ['\nUser:'], [`${emoji}c!`]]) {
      // Split between every code unit, which also cuts each pair in half.
      const chunks = text.split('');
      const scanner = new StopScanner(stops);
      const pieces: string[] = [];
      for (const chunk of chunks) pieces.push(scanner.push(chunk).emit);
      pieces.push(scanner.flush().emit);
      expect(pieces.join('')).toBe(text);
      for (const piece of pieces) {
        expect(piece.length === 0 || !/[\ud800-\udbff]$/.test(piece)).toBe(true);
        expect(/^[\udc00-\udfff]/.test(piece)).toBe(false);
      }
    }
  });

  it('matches a stop string that contains an emoji split across chunks', () => {
    const emoji = '\u{1F600}';
    const result = scan([`${emoji}!`], ['hi \ud83d', '\ude00', '! more']);
    expect(result).toMatchObject({ text: 'hi ', matched: true });
  });
});

function pick(r: { text: string; matched: boolean }): { text: string; matched: boolean } {
  return { text: r.text, matched: r.matched };
}
