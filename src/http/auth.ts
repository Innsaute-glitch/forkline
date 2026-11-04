import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Constant-time check of `Authorization: Bearer <key>`. Hashing makes both sides the same length. */
export function bearerMatches(header: string | undefined, apiKey: string): boolean {
  const match = /^Bearer[ \t]+(.+)$/i.exec(header ?? '');
  const presented = match?.[1] ?? '';
  const equal = timingSafeEqual(digest(presented), digest(apiKey));
  return equal && match !== null;
}
