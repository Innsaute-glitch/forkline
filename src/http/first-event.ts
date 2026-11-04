/**
 * Puts an already-pulled first event back in front of the rest of a generator.
 *
 * Written as a plain iterator, not a generator function, on purpose: ending a
 * generator function that never started skips its `finally`, so a wrapper that
 * is returned before it is read would leave the source (and the subprocess)
 * running. Here `return()` and `throw()` always reach the source.
 */
export function prepend<T>(
  first: T,
  rest: AsyncGenerator<T, unknown, undefined>,
): AsyncIterableIterator<T> {
  let pending = true;
  const wrapper: AsyncIterableIterator<T> = {
    async next(): Promise<IteratorResult<T>> {
      if (pending) {
        pending = false;
        return { value: first, done: false };
      }
      return rest.next();
    },
    async return(value?: unknown): Promise<IteratorResult<T>> {
      pending = false;
      return rest.return(value);
    },
    async throw(error?: unknown): Promise<IteratorResult<T>> {
      pending = false;
      return rest.throw(error);
    },
    [Symbol.asyncIterator]() {
      return wrapper;
    },
  };
  return wrapper;
}
