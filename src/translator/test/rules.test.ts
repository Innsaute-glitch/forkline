import { describe, expect, it } from 'vitest';
import { goldenConfig } from '../../test/helpers.js';
import type { ChatRequest, OpenAIContentPart, OpenAIMessage, TranslatedRequest } from '../../types.js';
import { translate } from '../index.js';

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const user = (content: unknown): OpenAIMessage => ({ role: 'user', content: content as string });
const base = (extra: Record<string, unknown> = {}, messages?: OpenAIMessage[]): ChatRequest => ({
  model: 'claude-sonnet-5-5',
  messages: messages ?? [user('Hello there.')],
  ...extra,
});

function ok(request: ChatRequest, config = goldenConfig()): TranslatedRequest {
  const result = translate(request, config);
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}
function bad(request: ChatRequest, config = goldenConfig()) {
  const result = translate(request, config);
  if (result.ok) throw new Error('expected an error');
  return result.error;
}

describe('message content', () => {
  it('joins text parts of a system message with no separator, with no adjustment', () => {
    const value = ok(
      base({}, [
        { role: 'system', content: [{ type: 'text', text: 'Be ' }, { type: 'text', text: 'brief.' }] },
        user('Hi'),
      ]),
    );
    expect(value.systemPrompt[1]).toBe('Be brief.');
    expect(value.adjustments).toEqual(['system-header-added']);
  });

  it('joins text parts of an assistant message in history', () => {
    const value = ok(
      base({}, [
        { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
        user('Hi'),
      ]),
    );
    expect(value.history).toEqual([{ role: 'assistant', content: 'ab' }]);
  });

  it('rejects an image part on a system or assistant message', () => {
    const part = { type: 'image_url', image_url: { url: PNG } } as unknown as OpenAIContentPart;
    expect(bad(base({}, [{ role: 'system', content: [part] }, user('Hi')])).status).toBe(400);
    expect(bad(base({}, [{ role: 'assistant', content: [part] }, user('Hi')])).status).toBe(400);
  });

  it('turns null or missing content on system and assistant into an empty string', () => {
    const value = ok(
      base({}, [
        { role: 'system', content: null },
        { role: 'system' },
        { role: 'assistant', content: null },
        { role: 'assistant' },
        user('Hi'),
      ]),
    );
    expect(value.systemPrompt.slice(1)).toEqual(['', '']);
    expect(value.history).toEqual([
      { role: 'assistant', content: '' },
      { role: 'assistant', content: '' },
    ]);
    expect(value.adjustments).toEqual(['environment-block-replaced', 'system-header-added']);
  });

  it('counts null or missing user content as blank: dropped in history, 400 as the live prompt', () => {
    const value = ok(base({}, [user(null), { role: 'user' }, user('Hi')]));
    expect(value.history).toEqual([]);
    expect(value.adjustments).toContain('blank-user-dropped');
    expect(bad(base({}, [user('Hi'), user(null)])).status).toBe(400);
  });

  it('keeps empty system messages, and whitespace-only ones in the leading block', () => {
    const value = ok(base({}, [{ role: 'system', content: '' }, { role: 'system', content: '  ' }, user('Hi'), { role: 'system', content: '' }]));
    expect(value.systemPrompt.slice(1)).toEqual(['', '  ']);
    expect(value.history).toEqual([{ role: 'system', content: '' }]);
    expect(value.adjustments).toEqual(['environment-block-replaced', 'system-header-added', 'system-position-changed', 'trailing-system-moved']);
  });

  it('reports environment-block-replaced only when there is history', () => {
    expect(ok(base({}, [user('Hi')])).adjustments).not.toContain('environment-block-replaced');
    expect(ok(base({}, [user(' '), user('Hi')])).adjustments).not.toContain('environment-block-replaced');
    expect(ok(base({}, [{ role: 'assistant', content: 'A' }, user('Hi')])).adjustments).toContain('environment-block-replaced');
  });

  describe('system-position-changed', () => {
    const a = (content: string) => ({ role: 'assistant', content });
    const s = (content: string) => ({ role: 'system', content });
    const flag = 'system-position-changed';

    it('fires for a system message directly before a user message, at any depth', () => {
      expect(ok(base({}, [a('G'), s('N'), user('U1'), a('A1'), user('U2')])).adjustments).toContain(flag);
      expect(ok(base({}, [user('U1'), a('A1'), s('N'), user('U2')])).adjustments).toContain(flag);
    });

    it('stays quiet when the message keeps its place', () => {
      expect(ok(base({}, [user('U1'), s('N'), a('A1'), user('U2')])).adjustments).not.toContain(flag);
      expect(ok(base({}, [a('G'), user('U1'), a('A1'), user('U2'), s('Lore')])).adjustments).not.toContain(flag);
    });

    it('fires when no user message comes before the system message', () => {
      expect(ok(base({}, [user('U1'), s('Lore')])).adjustments).toContain(flag);
    });

    it('fires for any history system message on a model that folds them', () => {
      const config = goldenConfig();
      config.models[0] = { ...config.models[0]!, foldsSystemMessages: true };
      const request = { model: config.models[0].id, messages: [user('U1'), s('N'), a('A1'), user('U2')] };
      const result = translate(request, config);
      expect(result.ok && result.value.adjustments).toContain(flag);
      const noSystem = translate({ model: config.models[0].id, messages: [a('A'), user('U')] }, config);
      expect(noSystem.ok && noSystem.value.adjustments).not.toContain(flag);
    });
  });

  it('drops whitespace-only system messages from history and reports it', () => {
    const mid = ok(base({}, [{ role: 'assistant', content: 'A' }, { role: 'system', content: ' \n ' }, user('Hi')]));
    expect(mid.history).toEqual([{ role: 'assistant', content: 'A' }]);
    expect(mid.adjustments).toContain('blank-system-dropped');

    const trailing = ok(base({}, [user('Hi'), { role: 'system', content: '  ' }, { role: 'system', content: 'Lore' }]));
    expect(trailing.history).toEqual([{ role: 'system', content: 'Lore' }]);
    expect(trailing.adjustments).toContain('blank-system-dropped');
    expect(trailing.adjustments).toContain('trailing-system-moved');
  });

  it('treats user array content with only whitespace text as blank, and with an image as not blank', () => {
    expect(bad(base({}, [user('Hi'), user([{ type: 'text', text: ' ' }])])).status).toBe(400);
    expect(bad(base({}, [user([])])).status).toBe(400);
    const value = ok(base({}, [user([{ type: 'text', text: ' ' }]), user([{ type: 'image_url', image_url: { url: PNG } }])]));
    expect(value.history).toEqual([]);
    expect(value.livePrompt.content).toEqual([{ type: 'image_url', image_url: { url: PNG } }]);
  });

  it('keeps user array content exactly as sent, extra part keys included', () => {
    const content = [
      { type: 'text', text: 'Look  ' },
      { type: 'image_url', image_url: { url: PNG, detail: 'high' } },
    ];
    expect(ok(base({}, [user(content)])).livePrompt.content).toEqual(content);
  });

  it('does not keep extra message keys', () => {
    const value = ok(
      base({}, [{ role: 'assistant', content: 'a', name: 'Mira', partial: true }, user('Hi')]),
    );
    expect(value.history).toEqual([{ role: 'assistant', content: 'a' }]);
  });

  it('rejects content that is neither string, array nor null', () => {
    expect(bad(base({}, [user(5)])).status).toBe(400);
    expect(bad(base({}, [{ role: 'assistant', content: { a: 1 } as never }, user('Hi')])).status).toBe(400);
  });

  it('rejects unknown part types and parts without text', () => {
    expect(bad(base({}, [user([{ type: 'input_audio' }])])).status).toBe(400);
    expect(bad(base({}, [user([{ type: 'text' }])])).status).toBe(400);
    expect(bad(base({}, [{ role: 'system', content: [{ type: 'file' } as never] }, user('Hi')])).status).toBe(400);
  });

  it('flags reasoning_content and reasoning_details on assistant messages only when set', () => {
    const withField = (field: string, value: unknown) =>
      ok(base({}, [{ role: 'assistant', content: 'a', [field]: value }, user('Hi')])).adjustments;
    expect(withField('reasoning_content', 'x')).toContain('reasoning-replay-ignored');
    expect(withField('reasoning_details', [{ text: 'x' }])).toContain('reasoning-replay-ignored');
    expect(withField('reasoning_content', null)).not.toContain('reasoning-replay-ignored');
  });
});

describe('message structure', () => {
  it('rejects bad messages arrays', () => {
    expect(bad({ model: 'x', messages: [] }).status).toBe(400);
    expect(bad({ model: 'x', messages: 'hi' as unknown as OpenAIMessage[] }).status).toBe(400);
    expect(bad({ model: 'x', messages: null as unknown as OpenAIMessage[] }).status).toBe(400);
    expect(bad(base({}, ['hi' as unknown as OpenAIMessage])).status).toBe(400);
    expect(bad(null as unknown as ChatRequest).status).toBe(400);
  });

  it('rejects other roles and tool_calls, but not empty tool_calls', () => {
    expect(bad(base({}, [{ role: 'developer', content: 'x' }, user('Hi')])).status).toBe(400);
    expect(bad(base({}, [{ role: 'function', content: 'x' }, user('Hi')])).status).toBe(400);
    expect(bad(base({}, [{ role: 'assistant', content: 'x', tool_calls: [{ id: '1' }] }, user('Hi')])).status).toBe(400);
    expect(ok(base({}, [{ role: 'assistant', content: 'x', tool_calls: [] }, user('Hi')])).history).toHaveLength(1);
    expect(ok(base({}, [{ role: 'assistant', content: 'x', tool_calls: null }, user('Hi')])).history).toHaveLength(1);
  });

  it('uses the last user message as the live prompt and moves trailing systems before it', () => {
    const value = ok(
      base({}, [user('one'), user('two'), { role: 'system', content: 'S1' }, { role: 'system', content: 'S2' }]),
    );
    expect(value.livePrompt.content).toBe('two');
    expect(value.history.map((h) => h.content)).toEqual(['one', 'S1', 'S2']);
    expect(value.adjustments).toContain('trailing-system-moved');
  });

  it('rejects an assistant message after the last user message, even with a system after it', () => {
    expect(
      bad(base({}, [user('Hi'), { role: 'assistant', content: 'x' }, { role: 'system', content: 's' }])).status,
    ).toBe(400);
  });

  it('rejects a blank last user message even when an earlier user message has text', () => {
    expect(bad(base({}, [user('Hi'), { role: 'assistant', content: 'x' }, user('\n\t ')])).status).toBe(400);
  });

  it('keeps an assistant first message and consecutive same-role messages', () => {
    const value = ok(
      base({}, [{ role: 'assistant', content: 'greet' }, { role: 'assistant', content: 'again' }, user('Hi')]),
    );
    expect(value.history).toHaveLength(2);
  });

  it('puts only leading system messages in the system prompt', () => {
    const value = ok(
      base({}, [
        { role: 'system', content: 'S1' },
        { role: 'system', content: 'S2' },
        user('Hi'),
        { role: 'system', content: 'S3' },
        user('Again'),
      ]),
    );
    expect(value.systemPrompt.slice(1)).toEqual(['S1', 'S2']);
    expect(value.history).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'system', content: 'S3' },
    ]);
  });
});

describe('images', () => {
  const imageMsg = (url: unknown) =>
    user([{ type: 'image_url', image_url: { url } }]);

  it('accepts base64 png, jpeg, gif and webp data URLs', () => {
    for (const type of ['png', 'jpeg', 'gif', 'webp']) {
      expect(ok(base({}, [imageMsg(`data:image/${type};base64,AAAA`)])).livePrompt.role).toBe('user');
    }
  });

  it('rejects remote URLs, other types, non-base64 data URLs and malformed parts', () => {
    for (const url of [
      'https://example.com/a.png',
      'http://example.com/a.png',
      'data:image/svg+xml;base64,AAAA',
      'data:image/png,AAAA',
      'data:text/plain;base64,AAAA',
      'data:image/png;base64,',
      'data:image/png;base64,AA AA',
      '',
      undefined,
      5,
    ]) {
      expect(bad(base({}, [imageMsg(url)])).status).toBe(400);
    }
    expect(bad(base({}, [user([{ type: 'image_url', image_url: 'data:image/png;base64,AAAA' }])])).status).toBe(400);
    expect(bad(base({}, [user([{ type: 'image_url' }])])).status).toBe(400);
  });

  it('rejects a bad image even in an older history message', () => {
    expect(bad(base({}, [imageMsg('https://x.test/a.png'), user('Hi')])).status).toBe(400);
  });

  it('handles a multi-megabyte data URL', () => {
    const big = `data:image/png;base64,${'A'.repeat(8_000_000)}`;
    expect(ok(base({}, [imageMsg(big)])).livePrompt.content).toHaveLength(1);
  });
});

describe('top-level fields', () => {
  it('treats null fields as unset: no adjustment and no 400', () => {
    const value = ok(
      base({
        temperature: null,
        top_p: null,
        user: null,
        tools: null,
        tool_choice: null,
        max_tokens: null,
        max_completion_tokens: null,
        reasoning_effort: null,
        stop: null,
        stream: null,
        stream_options: null,
        n: null,
        response_format: null,
      }),
    );
    expect(value.adjustments).toEqual(['system-header-added']);
    expect(value.params).toEqual({
      stream: false,
      effort: 'medium',
      maxOutputTokens: null,
      stop: [],
      includeUsage: true,
    });
  });

  it('null model counts as missing', () => {
    const value = ok(base({ model: null }));
    expect(value.responseModel).toBe('claude-sonnet-5-5');
    expect(value.adjustments).toContain('model-defaulted');
  });

  it('reports user-ignored and every other unhandled field', () => {
    const value = ok(
      base({ user: 'abc', seed: 1, logit_bias: { 5: 1 }, top_k: 3, min_p: 0.1, presence_penalty: 0, metadata: {} }),
    );
    expect(value.adjustments).toEqual(
      [
        'system-header-added',
        'user-ignored',
        'seed-ignored',
        'logit_bias-ignored',
        'top_k-ignored',
        'min_p-ignored',
        'presence_penalty-ignored',
        'metadata-ignored',
      ].sort(),
    );
  });

  it('reports tools-ignored for tools or tool_choice alone', () => {
    expect(ok(base({ tools: [{ type: 'function' }] })).adjustments).toContain('tools-ignored');
    expect(ok(base({ tool_choice: 'auto' })).adjustments).toContain('tools-ignored');
  });

  it('n: 1 is fine, anything else is 400', () => {
    expect(ok(base({ n: 1 })).adjustments).toEqual(['system-header-added']);
    expect(bad(base({ n: 2 })).status).toBe(400);
    expect(bad(base({ n: 0 })).status).toBe(400);
    expect(bad(base({ n: '1' })).status).toBe(400);
  });

  it('rejects response_format', () => {
    expect(bad(base({ response_format: { type: 'text' } })).status).toBe(400);
  });

  it('stream must be a boolean', () => {
    expect(ok(base({ stream: true })).params.stream).toBe(true);
    expect(ok(base({ stream: false })).params.stream).toBe(false);
    expect(bad(base({ stream: 'yes' })).status).toBe(400);
  });
});

describe('model', () => {
  it('uses a configured id with no adjustment', () => {
    const value = ok(base({ model: 'claude-haiku-5-5' }));
    expect(value.claudeModel).toBe('claude-haiku-5-5');
    expect(value.responseModel).toBe('claude-haiku-5-5');
    expect(value.adjustments).toEqual(['system-header-added']);
  });

  it('defaults unknown, "none", empty and missing models', () => {
    for (const [model, echoed] of [
      ['gpt-4o', 'gpt-4o'],
      ['none', 'none'],
      ['', 'claude-sonnet-5-5'],
      [undefined, 'claude-sonnet-5-5'],
    ] as const) {
      const value = ok(base({ model }));
      expect(value.claudeModel).toBe('claude-sonnet-5-5');
      expect(value.responseModel).toBe(echoed);
      expect(value.adjustments).toContain('model-defaulted');
    }
  });

  it('rejects a non-string model', () => {
    expect(bad(base({ model: 5 })).status).toBe(400);
  });

  it('maps through the config table (id differs from the Claude id)', () => {
    const config = goldenConfig();
    config.models = [{ id: 'my-alias', claudeModel: 'claude-opus-5-5', maxOutputTokens: 1000 }];
    config.defaultModel = 'my-alias';
    const value = ok(base({ model: 'my-alias', max_tokens: 5000 }), config);
    expect(value.claudeModel).toBe('claude-opus-5-5');
    expect(value.responseModel).toBe('my-alias');
    expect(value.params.maxOutputTokens).toBe(1000);
  });
});

describe('max tokens', () => {
  it('prefers max_completion_tokens over max_tokens', () => {
    expect(ok(base({ max_completion_tokens: 100, max_tokens: 200 })).params.maxOutputTokens).toBe(100);
    expect(ok(base({ max_completion_tokens: null, max_tokens: 200 })).params.maxOutputTokens).toBe(200);
  });

  it('the first one set decides, even if the other is valid', () => {
    expect(bad(base({ max_completion_tokens: 0, max_tokens: 200 })).status).toBe(400);
  });

  it('rejects non-positive and non-integer values', () => {
    for (const badValue of [0, -1, 1.5, '100', true, NaN, [5]]) {
      expect(bad(base({ max_tokens: badValue })).status).toBe(400);
      expect(bad(base({ max_completion_tokens: badValue })).status).toBe(400);
    }
  });

  it('lowers values above the model maximum and reports it', () => {
    const value = ok(base({ max_tokens: 64001 }));
    expect(value.params.maxOutputTokens).toBe(64000);
    expect(value.adjustments).toContain('max-tokens-capped');
    const exact = ok(base({ max_tokens: 64000 }));
    expect(exact.params.maxOutputTokens).toBe(64000);
    expect(exact.adjustments).not.toContain('max-tokens-capped');
  });

  it('passes the value as sent when the model has no configured maximum', () => {
    const config = goldenConfig();
    config.models = config.models.map((m) => ({ ...m, maxOutputTokens: undefined }));
    const value = ok(base({ max_tokens: 500_000 }), config);
    expect(value.params.maxOutputTokens).toBe(500_000);
    expect(value.adjustments).not.toContain('max-tokens-capped');
  });
});

describe('reasoning_effort', () => {
  it.each(['low', 'medium', 'high', 'xhigh', 'max'])('passes %s on', (level) => {
    const value = ok(base({ reasoning_effort: level }));
    expect(value.params.effort).toBe(level);
    expect(value.adjustments).toEqual(['system-header-added']);
  });

  it.each(['minimal', 'none'])('maps %s to low with effort-mapped', (level) => {
    const value = ok(base({ reasoning_effort: level }));
    expect(value.params.effort).toBe('low');
    expect(value.adjustments).toContain('effort-mapped');
  });

  it('uses defaultEffort when unset', () => {
    const config = goldenConfig();
    config.defaultEffort = 'high';
    expect(ok(base(), config).params.effort).toBe('high');
  });

  it('rejects other values', () => {
    for (const v of ['extreme', 'HIGH', '', 3, true]) {
      expect(bad(base({ reasoning_effort: v })).status).toBe(400);
    }
  });
});

describe('stop and stream_options', () => {
  it('accepts a string, drops empty strings', () => {
    expect(ok(base({ stop: '\nUser:' })).params.stop).toEqual(['\nUser:']);
    expect(ok(base({ stop: '' })).params.stop).toEqual([]);
    expect(ok(base({ stop: ['a', '', 'b'] })).params.stop).toEqual(['a', 'b']);
    expect(ok(base({ stop: [] })).params.stop).toEqual([]);
  });

  it('keeps whitespace-only stop strings as sent', () => {
    expect(ok(base({ stop: ['\n'] })).params.stop).toEqual(['\n']);
  });

  it('rejects stop of the wrong type', () => {
    expect(bad(base({ stop: 5 })).status).toBe(400);
    expect(bad(base({ stop: ['a', 5] })).status).toBe(400);
    expect(bad(base({ stop: { a: 1 } })).status).toBe(400);
  });

  it('turns usage off only for include_usage: false', () => {
    expect(ok(base({ stream_options: { include_usage: false } })).params.includeUsage).toBe(false);
    expect(ok(base({ stream_options: { include_usage: true } })).params.includeUsage).toBe(true);
    expect(ok(base({ stream_options: {} })).params.includeUsage).toBe(true);
    expect(ok(base({ stream_options: { include_usage: 0 } })).params.includeUsage).toBe(true);
    expect(ok(base({ stream_options: 'x' })).params.includeUsage).toBe(true);
  });

  it('does not report stream_options, stop or n as ignored', () => {
    const value = ok(base({ stream_options: { include_usage: false }, stop: 'x', n: 1 }));
    expect(value.adjustments).toEqual(['system-header-added']);
  });
});

describe('adjustments list', () => {
  it('is de-duplicated and sorted ascending', () => {
    const value = ok(
      base({ temperature: 1, top_p: 1, tools: [], reasoning_effort: 'none', model: 'x' }, [
        user(''),
        { role: 'assistant', content: 'a', reasoning_content: 'r' },
        { role: 'assistant', content: 'b', reasoning_content: 'r' },
        user('Hi'),
        { role: 'system', content: 's' },
      ]),
    );
    expect(value.adjustments).toEqual([...new Set(value.adjustments)].sort());
    expect(value.adjustments).toEqual([
      'blank-user-dropped',
      'effort-mapped',
      'environment-block-replaced',
      'model-defaulted',
      'reasoning-replay-ignored',
      'system-header-added',
      'temperature-ignored',
      'tools-ignored',
      'top_p-ignored',
      'trailing-system-moved',
    ]);
  });
});
