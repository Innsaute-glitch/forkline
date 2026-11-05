// Shared test helpers. Test code only.
import { readFileSync } from 'node:fs';
import { parseConfig, type Config } from '../config.js';

export const fixturePath = (relative: string): URL =>
  new URL(`../../fixtures/${relative}`, import.meta.url);

export const readFixture = <T>(relative: string): T =>
  JSON.parse(readFileSync(fixturePath(relative), 'utf8')) as T;

export const readFixtureText = (relative: string): string =>
  readFileSync(fixturePath(relative), 'utf8');

export const TEST_ENV = {
  FORKLINE_API_KEY: 'test-key-0123456789abcdef',
  FORKLINE_CLAUDE_TOKEN: 'test-token',
};

/** The frozen config every golden test uses. */
export const goldenConfig = (): Config => parseConfig(readFixture('golden/config.json'), TEST_ENV);

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

export async function* fromArray<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}
