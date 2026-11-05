import { adjustmentsHeader } from '../chat.js';
import { describe, expect, it } from 'vitest';
import { bearerMatches } from '../auth.js';
import { prepend } from '../first-event.js';

describe('bearerMatches', () => {
  it('accepts exactly the key', () => {
    expect(bearerMatches('Bearer secret-key', 'secret-key')).toBe(true);
    expect(bearerMatches('bearer secret-key', 'secret-key')).toBe(true);
    expect(bearerMatches('Bearer secret-key ', 'secret-key')).toBe(false);
    expect(bearerMatches('Bearer secret-ke', 'secret-key')).toBe(false);
    expect(bearerMatches('Bearer secret-key-longer', 'secret-key')).toBe(false);
    expect(bearerMatches('secret-key', 'secret-key')).toBe(false);
    expect(bearerMatches('Basic secret-key', 'secret-key')).toBe(false);
    expect(bearerMatches('Bearer ', 'secret-key')).toBe(false);
    expect(bearerMatches(undefined, 'secret-key')).toBe(false);
  });
});

function source() {
  const state = { returned: false, pulled: 0 };
  async function* gen() {
    try {
      for (const n of [2, 3, 4]) {
        state.pulled += 1;
        yield n;
      }
    } finally {
      state.returned = true;
    }
  }
  return { state, gen: gen() };
}

describe('prepend', () => {
  it('yields the first event, then the rest', async () => {
    const { gen } = source();
    const out: number[] = [];
    for await (const n of prepend(1, gen)) out.push(n);
    expect(out).toEqual([1, 2, 3, 4]);
  });

  it('forwards return() after a break, so the source stops', async () => {
    const { state, gen } = source();
    for await (const n of prepend(1, gen)) {
      if (n === 2) break;
    }
    expect(state.returned).toBe(true);
  });

  it('forwards return() even if it was never read', async () => {
    const { state, gen } = source();
    await gen.next(); // the source has started, like a run that already gave its first event
    const wrapped = prepend(1, gen);
    await wrapped.return?.(undefined);
    expect(state.returned).toBe(true);
    expect(state.pulled).toBe(1);
  });

  it('breaking out at the put-back event also stops the source', async () => {
    const { state, gen } = source();
    await gen.next();
    for await (const n of prepend(1, gen)) {
      expect(n).toBe(1);
      break;
    }
    expect(state.returned).toBe(true);
  });
});

describe('adjustmentsHeader', () => {
  it('keeps normal names and makes any client field name legal in a header', () => {
    expect(adjustmentsHeader(['system-header-added', 'top_p-ignored'])).toBe('system-header-added,top_p-ignored');
    expect(adjustmentsHeader(['\u6e29\u5ea6-ignored', 'a\r\nb-ignored', 'c,d-ignored'])).toBe('??-ignored,a??b-ignored,c?d-ignored');
  });
});
