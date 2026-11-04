import { bridgeError } from '../errors.js';
import type { BridgeErrorInfo } from '../types.js';

export interface LimiterConfig {
  maxActive: number;
  maxQueued: number;
  queueTimeoutMs: number;
}

export type SlotResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: 'queue-full'; error: BridgeErrorInfo }
  | { ok: false; reason: 'aborted' };

export type LockResult =
  | { ok: true; release: () => void; /** True when another holder had to finish first. */ waited: boolean }
  | { ok: false; reason: 'aborted' };

export interface Limiter {
  /** Takes one run slot, waits in the queue, or fails with queue-full. */
  acquireSlot(signal?: AbortSignal): Promise<SlotResult>;
  /** Takes the per-session lock for `key`, in arrival order. */
  acquireLock(key: string, signal?: AbortSignal): Promise<LockResult>;
  stats(): { active: number; queued: number };
}

interface SlotWaiter {
  resolve: (result: SlotResult) => void;
  timer: NodeJS.Timeout;
  onAbort: (() => void) | null;
  signal: AbortSignal | undefined;
}

interface LockWaiter {
  resolve: (result: LockResult) => void;
  onAbort: (() => void) | null;
  signal: AbortSignal | undefined;
}

export function createLimiter(config: LimiterConfig): Limiter {
  let active = 0;
  const queue: SlotWaiter[] = [];
  const locks = new Map<string, LockWaiter[]>();

  const queueFull = (message: string): SlotResult => ({
    ok: false,
    reason: 'queue-full',
    error: bridgeError('queue-full', message),
  });

  function makeSlotRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = queue.shift();
      if (next) {
        // Hand the slot over directly: `active` stays the same.
        clearTimeout(next.timer);
        if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort);
        next.resolve({ ok: true, release: makeSlotRelease() });
      } else {
        active -= 1;
      }
    };
  }

  function acquireSlot(signal?: AbortSignal): Promise<SlotResult> {
    if (signal?.aborted) return Promise.resolve({ ok: false, reason: 'aborted' });
    if (active < config.maxActive) {
      active += 1;
      return Promise.resolve({ ok: true, release: makeSlotRelease() });
    }
    if (queue.length >= config.maxQueued) {
      return Promise.resolve(queueFull('server is busy: too many requests are waiting'));
    }
    return new Promise<SlotResult>((resolve) => {
      const waiter: SlotWaiter = {
        resolve,
        signal,
        onAbort: null,
        timer: setTimeout(() => {
          remove();
          resolve(queueFull('server is busy: timed out waiting for a free slot'));
        }, config.queueTimeoutMs),
      };
      const remove = () => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        clearTimeout(waiter.timer);
        if (waiter.onAbort) signal?.removeEventListener('abort', waiter.onAbort);
      };
      if (signal) {
        waiter.onAbort = () => {
          remove();
          resolve({ ok: false, reason: 'aborted' });
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      queue.push(waiter);
    });
  }

  function makeLockRelease(key: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiters = locks.get(key);
      const next = waiters?.shift();
      if (next) {
        if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort);
        next.resolve({ ok: true, release: makeLockRelease(key), waited: true });
      } else {
        locks.delete(key);
      }
    };
  }

  function acquireLock(key: string, signal?: AbortSignal): Promise<LockResult> {
    if (signal?.aborted) return Promise.resolve({ ok: false, reason: 'aborted' });
    const waiters = locks.get(key);
    if (!waiters) {
      locks.set(key, []);
      return Promise.resolve({ ok: true, release: makeLockRelease(key), waited: false });
    }
    return new Promise<LockResult>((resolve) => {
      const waiter: LockWaiter = { resolve, signal, onAbort: null };
      if (signal) {
        waiter.onAbort = () => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          resolve({ ok: false, reason: 'aborted' });
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      waiters.push(waiter);
    });
  }

  return {
    acquireSlot,
    acquireLock,
    stats: () => ({ active, queued: queue.length }),
  };
}
