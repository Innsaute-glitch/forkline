import { describe, expect, it } from 'vitest';
import { createLimiter } from '../limiter.js';

const cfg = (over: Partial<{ maxActive: number; maxQueued: number; queueTimeoutMs: number }> = {}) => ({
  maxActive: 1,
  maxQueued: 1,
  queueTimeoutMs: 1000,
  ...over,
});

async function slot(l: ReturnType<typeof createLimiter>, signal?: AbortSignal) {
  const r = await l.acquireSlot(signal);
  if (!r.ok) throw new Error(`no slot: ${r.reason}`);
  return r;
}

describe('slots', () => {
  it('takes up to maxActive, queues, then reports queue-full (503)', async () => {
    const l = createLimiter(cfg());
    const a = await slot(l);
    const queued = l.acquireSlot();
    expect(l.stats()).toEqual({ active: 1, queued: 1 });
    const full = await l.acquireSlot();
    expect(full).toMatchObject({ ok: false, reason: 'queue-full', error: { code: 'queue-full', status: 503 } });
    a.release();
    const b = await queued;
    expect(b.ok).toBe(true);
    expect(l.stats()).toEqual({ active: 1, queued: 0 });
    if (b.ok) b.release();
    expect(l.stats()).toEqual({ active: 0, queued: 0 });
  });

  it('release is idempotent', async () => {
    const l = createLimiter(cfg({ maxActive: 2 }));
    const a = await slot(l);
    await slot(l);
    a.release();
    a.release();
    expect(l.stats().active).toBe(1);
  });

  it('serves the queue in arrival order', async () => {
    const l = createLimiter(cfg({ maxQueued: 3 }));
    const a = await slot(l);
    const order: number[] = [];
    const waits = [1, 2, 3].map((n) => l.acquireSlot().then((r) => { order.push(n); if (r.ok) r.release(); }));
    a.release();
    await Promise.all(waits);
    expect(order).toEqual([1, 2, 3]);
    expect(l.stats()).toEqual({ active: 0, queued: 0 });
  });

  it('times out of the queue with queue-full', async () => {
    const l = createLimiter(cfg({ queueTimeoutMs: 20 }));
    await slot(l);
    const r = await l.acquireSlot();
    expect(r).toMatchObject({ ok: false, reason: 'queue-full' });
    expect(l.stats().queued).toBe(0);
  });

  it('leaves the queue when the signal aborts, and does not take the slot later', async () => {
    const l = createLimiter(cfg());
    const a = await slot(l);
    const ctl = new AbortController();
    const waiting = l.acquireSlot(ctl.signal);
    ctl.abort();
    expect(await waiting).toEqual({ ok: false, reason: 'aborted' });
    expect(l.stats().queued).toBe(0);
    a.release();
    expect(l.stats().active).toBe(0);
  });

  it('an already-aborted signal gets nothing', async () => {
    const l = createLimiter(cfg());
    const ctl = new AbortController();
    ctl.abort();
    expect(await l.acquireSlot(ctl.signal)).toEqual({ ok: false, reason: 'aborted' });
    expect(l.stats().active).toBe(0);
  });

  it('maxQueued 0 never queues', async () => {
    const l = createLimiter(cfg({ maxQueued: 0 }));
    await slot(l);
    expect(await l.acquireSlot()).toMatchObject({ ok: false, reason: 'queue-full' });
  });
});

describe('locks', () => {
  it('different keys do not block each other; the same key waits in order', async () => {
    const l = createLimiter(cfg());
    const a = await l.acquireLock('k');
    expect(a).toMatchObject({ ok: true, waited: false });
    const other = await l.acquireLock('j');
    expect(other).toMatchObject({ ok: true, waited: false });
    const order: string[] = [];
    const w1 = l.acquireLock('k').then((r) => { order.push('1'); return r; });
    const w2 = l.acquireLock('k').then((r) => { order.push('2'); return r; });
    await Promise.resolve();
    expect(order).toEqual([]);
    if (a.ok) a.release();
    const r1 = await w1;
    expect(r1).toMatchObject({ ok: true, waited: true });
    expect(order).toEqual(['1']);
    if (r1.ok) r1.release();
    const r2 = await w2;
    expect(r2).toMatchObject({ ok: true, waited: true });
    if (r2.ok) r2.release();
    // free again
    expect(await l.acquireLock('k')).toMatchObject({ ok: true, waited: false });
  });

  it('release is idempotent and does not hand the lock twice', async () => {
    const l = createLimiter(cfg());
    const a = await l.acquireLock('k');
    const w = l.acquireLock('k');
    if (a.ok) { a.release(); a.release(); }
    const b = await w;
    expect(b.ok).toBe(true);
    const c = l.acquireLock('k');
    let got = false;
    void c.then(() => { got = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toBe(false);
    if (b.ok) b.release();
    expect((await c).ok).toBe(true);
  });

  it('a waiter whose signal aborts leaves without taking the lock', async () => {
    const l = createLimiter(cfg());
    const a = await l.acquireLock('k');
    const ctl = new AbortController();
    const w = l.acquireLock('k', ctl.signal);
    const w2 = l.acquireLock('k');
    ctl.abort();
    expect(await w).toEqual({ ok: false, reason: 'aborted' });
    if (a.ok) a.release();
    const next = await w2;
    expect(next).toMatchObject({ ok: true, waited: true });
  });
});
