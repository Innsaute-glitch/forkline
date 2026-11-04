import { describe, expect, it } from 'vitest';
import { SSE_DONE } from '../../constants.js';
import { bridgeError } from '../../errors.js';
import { collect, fromArray, readFixture, readFixtureText } from '../../test/helpers.js';
import type {
  ChatCompletion,
  RunEvent,
  StreamContext,
  StreamResult,
  TokenUsage,
} from '../../types.js';
import { toCompletion, toSse } from '../index.js';

type CtxFixture = Omit<StreamContext, 'onStopMatched' | 'onDone'>;

function makeCtx(overrides: Partial<StreamContext> = {}) {
  const fixture = readFixture<CtxFixture>('golden/stream-context.json');
  const done: StreamResult[] = [];
  let stopCalls = 0;
  const ctx: StreamContext = {
    ...fixture,
    onStopMatched: () => {
      stopCalls += 1;
    },
    onDone: (result) => {
      done.push(result);
    },
    ...overrides,
  };
  return { ctx, done, stopCalls: () => stopCalls };
}

const events = (name: string): RunEvent[] => readFixture<RunEvent[]>(`run-events/${name}.json`);
const usage: TokenUsage = { inputTokens: 12, outputTokens: 40, cacheReadTokens: 3000, cacheWriteTokens: 25 };
const started: RunEvent = { type: 'started', sessionId: 's', model: 'claude-sonnet-5-5' };
const finished: RunEvent = { type: 'finished', sessionId: 's', finishReason: 'stop', usage };

const parseFrames = (frames: string[]): unknown[] =>
  frames.filter((f) => f !== SSE_DONE).map((f) => JSON.parse(f.slice('data: '.length)));
const contents = (frames: string[]): string =>
  parseFrames(frames)
    .map((f) => (f as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content ?? '')
    .join('');

describe('golden output', () => {
  for (const name of ['plain-text', 'thinking-then-text', 'refusal', 'error-after-start']) {
    it(`toSse ${name} is byte-equal to the golden`, async () => {
      const { ctx, done } = makeCtx();
      const frames = await collect(toSse(fromArray(events(name)), ctx));
      expect(frames.join('')).toBe(readFixtureText(`golden/sse/${name}.sse`));
      expect(done).toHaveLength(1);
    });
  }

  it('toCompletion thinking-then-text equals the golden', async () => {
    const { ctx, done } = makeCtx();
    const result = await toCompletion(fromArray(events('thinking-then-text')), ctx);
    expect(result).toEqual({
      ok: true,
      body: readFixture<ChatCompletion>('golden/completion/thinking-then-text.json'),
    });
    // Same bytes once serialised, key order included.
    if (result.ok) {
      expect(JSON.stringify(result.body, null, 2) + '\n').toBe(
        readFixtureText('golden/completion/thinking-then-text.json'),
      );
    }
    expect(done).toHaveLength(1);
  });

  it('thinking-then-text onDone carries the accumulated texts and usage', async () => {
    const { ctx, done } = makeCtx();
    await collect(toSse(fromArray(events('thinking-then-text')), ctx));
    expect(done[0]).toEqual({
      replyText: '"Stay by the fire."',
      reasoningText: 'She is wary.',
      stopMatched: false,
      finishReason: 'stop',
      usage,
      error: null,
    });
  });

  it('omits the usage chunk when includeUsage is false', async () => {
    const { ctx } = makeCtx({ includeUsage: false });
    const frames = await collect(toSse(fromArray(events('plain-text')), ctx));
    expect(frames.join('')).not.toContain('"usage"');
    expect(frames.at(-1)).toBe(SSE_DONE);
    expect(frames.at(-2)).toContain('"finish_reason":"stop"');
  });
});

describe('stop strings', () => {
  it('text-with-stop matches across the chunk boundary and leaves "Mira nods."', async () => {
    const { ctx, done, stopCalls } = makeCtx({ stop: ['\nUser:'] });
    const frames = await collect(toSse(fromArray(events('text-with-stop')), ctx));
    expect(contents(frames)).toBe('Mira nods.');
    expect(stopCalls()).toBe(1);
    const parsed = parseFrames(frames) as { choices: { finish_reason: string | null }[]; usage?: unknown }[];
    const last = parsed.at(-1)!;
    expect(last.choices[0]?.finish_reason).toBe('stop');
    expect(last.usage).toBeUndefined();
    expect(frames.join('')).not.toContain('"usage"');
    expect(frames.at(-1)).toBe(SSE_DONE);
    expect(done).toHaveLength(1);
    expect(done[0]).toEqual({
      replyText: 'Mira nods.',
      reasoningText: '',
      stopMatched: true,
      finishReason: 'stop',
      usage: null,
      error: null,
    });
  });

  it('toCompletion with a stop match returns the truncated text with finish_reason stop', async () => {
    const { ctx, done, stopCalls } = makeCtx({ stop: ['\nUser:'] });
    const result = await toCompletion(fromArray(events('text-with-stop')), ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.choices[0].message.content).toBe('Mira nods.');
      expect(result.body.choices[0].finish_reason).toBe('stop');
      expect(result.body.usage).toBeUndefined();
    }
    expect(stopCalls()).toBe(1);
    expect(done[0]?.stopMatched).toBe(true);
  });

  it('stops reading events after a match and closes the upstream iterator', async () => {
    let returned = false;
    let pulledAfterMatch = false;
    async function* upstream(): AsyncGenerator<RunEvent> {
      try {
        yield started;
        yield { type: 'text', text: 'ok STOP tail' };
        pulledAfterMatch = true;
        yield { type: 'text', text: 'never' };
        yield finished;
      } finally {
        returned = true;
      }
    }
    const { ctx } = makeCtx({ stop: ['STOP'] });
    const frames = await collect(toSse(upstream(), ctx));
    expect(contents(frames)).toBe('ok ');
    expect(pulledAfterMatch).toBe(false);
    expect(returned).toBe(true);
  });

  it('a match inside held text at the end of the run still counts', async () => {
    const { ctx, done, stopCalls } = makeCtx({ stop: ['abcd', 'c'] });
    const frames = await collect(
      toSse(fromArray<RunEvent>([started, { type: 'text', text: 'abc' }, finished]), ctx),
    );
    expect(contents(frames)).toBe('ab');
    expect(stopCalls()).toBe(1);
    expect(done[0]).toMatchObject({ replyText: 'ab', stopMatched: true, finishReason: 'stop', usage: null });
  });

  it('applies stop strings to text only, never reasoning', async () => {
    const { ctx, stopCalls } = makeCtx({ stop: ['wary'] });
    const frames = await collect(toSse(fromArray(events('thinking-then-text')), ctx));
    expect(frames.join('')).toContain('"reasoning_content":"wary."');
    expect(stopCalls()).toBe(0);
  });

  it('releases held text when the run ends', async () => {
    const { ctx, done } = makeCtx({ stop: ['STOP'] });
    const frames = await collect(
      toSse(fromArray<RunEvent>([started, { type: 'text', text: 'almost ST' }, finished]), ctx),
    );
    expect(contents(frames)).toBe('almost ST');
    expect(done[0]?.replyText).toBe('almost ST');
    expect(done[0]?.stopMatched).toBe(false);
  });

  it('any chunking of one reply streams the same text (property)', async () => {
    const reply = 'Mira nods.\nUser: thanks again';
    for (let size = 1; size <= reply.length; size += 1) {
      const text: RunEvent[] = [];
      for (let at = 0; at < reply.length; at += size) {
        text.push({ type: 'text', text: reply.slice(at, at + size) });
      }
      const { ctx } = makeCtx({ stop: ['\nUser:'] });
      const frames = await collect(toSse(fromArray<RunEvent>([started, ...text, finished]), ctx));
      expect(contents(frames)).toBe('Mira nods.');
    }
  });

  it('never splits a surrogate pair across SSE chunks', async () => {
    const reply = 'a\u{1F600}b\u{1F600}';
    const text: RunEvent[] = reply.split('').map((unit) => ({ type: 'text', text: unit }));
    const { ctx } = makeCtx();
    const frames = await collect(toSse(fromArray<RunEvent>([started, ...text, finished]), ctx));
    const pieces = (parseFrames(frames) as { choices: { delta: { content?: string } }[] }[])
      .map((f) => f.choices[0]?.delta.content)
      .filter((c): c is string => typeof c === 'string' && c.length > 0);
    expect(pieces.join('')).toBe(reply);
    for (const piece of pieces) expect(/[\ud800-\udbff]$/.test(piece)).toBe(false);
  });
});

describe('errors', () => {
  it('releases held text, then the error chunk, then [DONE]', async () => {
    const { ctx, done } = makeCtx({ stop: ['STOP'] });
    const error = bridgeError('output-limit', 'reply exceeded max_tokens');
    const frames = await collect(
      toSse(fromArray<RunEvent>([started, { type: 'text', text: 'Part ST' }, { type: 'error', error }]), ctx),
    );
    expect(contents(frames)).toBe('Part ST');
    expect(frames.at(-2)).toBe(
      'data: {"error":{"message":"reply exceeded max_tokens","type":"output-limit","code":400}}\n\n',
    );
    expect(frames.at(-1)).toBe(SSE_DONE);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ replyText: 'Part ST', finishReason: null, usage: null, error });
  });

  it('an error as the first event sends only the error frame and [DONE]', async () => {
    const { ctx, done } = makeCtx();
    const frames = await collect(toSse(fromArray(events('error-before-start')), ctx));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toContain('"type":"usage-limit"');
    expect(frames[1]).toBe(SSE_DONE);
    expect(done[0]?.error?.code).toBe('usage-limit');
  });

  it('toCompletion returns the error as ok:false', async () => {
    const { ctx, done } = makeCtx();
    const result = await toCompletion(fromArray(events('error-after-start')), ctx);
    expect(result).toEqual({
      ok: false,
      error: bridgeError('output-limit', 'reply exceeded max_tokens'),
    });
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ replyText: 'Partial', finishReason: null, error: { code: 'output-limit' } });
  });

  it('toCompletion on a refusal gives empty content and content_filter', async () => {
    const { ctx } = makeCtx();
    const result = await toCompletion(fromArray(events('refusal')), ctx);
    expect(result.ok && result.body.choices[0].finish_reason).toBe('content_filter');
    expect(result.ok && result.body.choices[0].message).toEqual({ role: 'assistant', content: '' });
  });
});

describe('onDone fires once in each outcome', () => {
  it('finished (stream and completion)', async () => {
    const a = makeCtx();
    await collect(toSse(fromArray(events('plain-text')), a.ctx));
    expect(a.done).toHaveLength(1);
    const b = makeCtx();
    await toCompletion(fromArray(events('plain-text')), b.ctx);
    expect(b.done).toHaveLength(1);
  });

  it('stop match (stream and completion)', async () => {
    const a = makeCtx({ stop: ['\nUser:'] });
    await collect(toSse(fromArray(events('text-with-stop')), a.ctx));
    expect(a.done).toHaveLength(1);
    expect(a.stopCalls()).toBe(1);
    const b = makeCtx({ stop: ['\nUser:'] });
    await toCompletion(fromArray(events('text-with-stop')), b.ctx);
    expect(b.done).toHaveLength(1);
    expect(b.stopCalls()).toBe(1);
  });

  it('error (stream and completion)', async () => {
    const a = makeCtx();
    await collect(toSse(fromArray(events('error-after-start')), a.ctx));
    expect(a.done).toHaveLength(1);
    const b = makeCtx();
    await toCompletion(fromArray(events('error-after-start')), b.ctx);
    expect(b.done).toHaveLength(1);
  });

  it('abort: events end with no terminal event', async () => {
    const partial: RunEvent[] = [started, { type: 'reasoning', text: 'hm' }, { type: 'text', text: 'Hel' }];

    const a = makeCtx({ stop: ['STOP'] });
    const frames = await collect(toSse(fromArray(partial), a.ctx));
    // Nothing after the content already sent: no final chunk, no error, no [DONE].
    expect(frames.join('')).not.toContain('finish_reason":"stop"');
    expect(frames.join('')).not.toContain('"error"');
    expect(frames).not.toContain(SSE_DONE);
    expect(a.done).toHaveLength(1);
    expect(a.done[0]).toMatchObject({ finishReason: null, usage: null, error: null, stopMatched: false });

    const b = makeCtx();
    const result = await toCompletion(fromArray(partial), b.ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('upstream');
    expect(b.done).toHaveLength(1);
    expect(b.done[0]).toMatchObject({ finishReason: null, usage: null });
  });

  it('abort with no events at all sends nothing', async () => {
    const a = makeCtx();
    expect(await collect(toSse(fromArray<RunEvent>([]), a.ctx))).toEqual([]);
    expect(a.done).toHaveLength(1);
    expect(a.done[0]).toMatchObject({ replyText: '', finishReason: null, error: null });
  });

  it('consumer stops early: onDone once, upstream closed', async () => {
    let returned = false;
    async function* upstream(): AsyncGenerator<RunEvent> {
      try {
        yield started;
        yield { type: 'text', text: 'one' };
        yield { type: 'text', text: 'two' };
        yield finished;
      } finally {
        returned = true;
      }
    }
    const a = makeCtx();
    for await (const frame of toSse(upstream(), a.ctx)) {
      if (frame.includes('"one"')) break;
    }
    expect(a.done).toHaveLength(1);
    expect(a.done[0]).toMatchObject({ replyText: 'one', finishReason: null, error: null });
    expect(returned).toBe(true);
  });

  it('consumer stops after the final frames: the real outcome stands, once', async () => {
    const a = makeCtx();
    for await (const frame of toSse(fromArray(events('plain-text')), a.ctx)) {
      if (frame === SSE_DONE) break;
    }
    expect(a.done).toHaveLength(1);
    expect(a.done[0]?.finishReason).toBe('stop');
  });

  it('events that throw: onDone once with an upstream error, then rethrown', async () => {
    async function* upstream(): AsyncGenerator<RunEvent> {
      yield started;
      throw new Error('boom');
    }
    const a = makeCtx();
    await expect(collect(toSse(upstream(), a.ctx))).rejects.toThrow('boom');
    expect(a.done).toHaveLength(1);
    expect(a.done[0]?.error?.code).toBe('upstream');
  });
});
