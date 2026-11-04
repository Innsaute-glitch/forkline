// Checks 8 to 11: attachments and tools, slash commands, thinking text, injected text.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SDK_VERSION } from '../../../src/constants.js';
import { captureRequest, flattenMessages, systemBlocks, type CapturedBody } from '../capture.js';
import {
  assert, chat, expected, has, mustReply, quote, resumePlan, routerFor, system, translateChat, user, assistant,
  Failure, Skip, type Ctx,
} from '../harness.js';
import type { Check } from './types.js';

export const check8: Check = {
  id: '8',
  title: '@file with attachments off shows no file contents; tools: [] sends 0 tools',
  cost: 'Haiku x1',
  async run(ctx) {
    const inside = 'TURQUOISE-ANVIL-9921';
    const outside = 'OUTSIDE-HERON-4410';
    writeFileSync(join(ctx.workDir, 'note.txt'), `The secret is ${inside}.\n`);
    const outsidePath = join(ctx.root, 'outside.txt');
    writeFileSync(outsidePath, `The secret is ${outside}.\n`);
    const t = translateChat(ctx, [
      system('Keep replies short.'),
      user(`Read @note.txt and @${outsidePath} and tell me what the secrets in them are. If you cannot see their contents, say NOFILE.`),
    ]);
    const plan = await routerFor(ctx, ctx.captureConfig).route(t);
    const cap = await captureRequest(t, plan, ctx.captureConfig);
    const wire = JSON.stringify(cap.body);
    assert(!wire.includes(inside) && !wire.includes(outside), 'file contents reached the request');
    const tools = cap.body.tools ?? [];
    const wantTools = expected(ctx, 0, 1);
    assert(tools.length === wantTools, `the request carries ${tools.length} tools, wanted ${wantTools}`);
    const live = await chat(ctx, t);
    mustReply('live', live);
    assert(!live.text.includes(inside) && !live.text.includes(outside), `the model saw file contents: ${quote(live.text)}`);
    return `no file text in the request or the reply; ${tools.length} tools`;
  },
};

const COMMANDS = ['/help', '/init', '/me waves at the ferryman'];

export const check9: Check = {
  id: '9',
  title: '/help, /init and /me ... reach the model as written, on a new and a resumed session',
  cost: 'Haiku x6, tiny prompts',
  async run(ctx) {
    const lines: string[] = [];
    for (const command of COMMANDS) {
      // New session (case A).
      const fresh = translateChat(ctx, [system('Reply in at most one short sentence.'), user(command)]);
      const freshCap = await captureRequest(fresh, await routerFor(ctx, ctx.captureConfig).route(fresh), ctx.captureConfig);
      checkLastUser('new session', command, freshCap.body, ctx);
      const first = await chat(ctx, fresh);
      mustReply(`${command} on a new session`, first);
      assert(first.startedModel !== null && first.totalInput > 0, `${command} on a new session never reached the model`);

      // Resumed session. The capture rebuilds a stored history (case D); the live run resumes the one just made (case B).
      const rebuilt = translateChat(ctx, [system('Reply in at most one short sentence.'), user('Hello.'), assistant('Hello.'), user(command)]);
      const rebuiltCap = await captureRequest(rebuilt, await routerFor(ctx, ctx.captureConfig).route(rebuilt), ctx.captureConfig);
      checkLastUser('resumed session', command, rebuiltCap.body, ctx);
      const again = await chat(ctx, fresh, resumePlan(first.plan));
      mustReply(`${command} on a resumed session`, again);
      assert(again.startedModel !== null && again.totalInput > 0, `${command} on a resumed session never reached the model`);
      lines.push(command.split(' ')[0]!);
    }
    return `${lines.join(', ')} reached the model unchanged on both`;
  },
};

function checkLastUser(where: string, command: string, body: CapturedBody, ctx: Ctx): void {
  const users = flattenMessages(body).filter((message) => message.role === 'user');
  const last = users.at(-1)?.text ?? '';
  const want = expected(ctx, command, `${command} (changed)`);
  assert(last === want, `${command} on a ${where} reached the model as ${quote(last)}, wanted ${quote(want)}`);
}

export const check10: Check = {
  id: '10',
  title: "thinking.display 'summarized': thinking_delta text arrives",
  cost: 'Haiku x1 (x2 if it does not think the first time)',
  async run(ctx) {
    if (ctx.config.thinkingDisplay !== 'summarized') {
      throw new Skip(`config.thinkingDisplay is "${ctx.config.thinkingDisplay}"`);
    }
    const prompts = [
      'What is 17 x 23 + 389 / 7, rounded to one decimal? Give only the number.',
      'A train leaves at 9:47 and travels 312 km at 83 km/h with two stops of 11 and 17 minutes. When does it arrive? Give only the time.',
    ];
    let last = '';
    for (const prompt of prompts) {
      const t = translateChat(ctx, [system('Keep replies short.'), user(prompt)], { effort: 'high' });
      const result = await chat(ctx, t);
      mustReply('thinking run', result);
      last = result.reasoning;
      if (expected(ctx, last.trim().length, 0) > 0) return `${result.reasoning.length} characters of thinking text`;
    }
    throw new Failure('no thinking_delta text arrived on either prompt');
  },
};

// ---- Check 11 ----

interface Snapshot {
  system: string[];
  messages: { role: string; text: string }[];
}

interface Baseline {
  sdk: string;
  recordedAt: string;
  model: string;
  /** Total prompt tokens (input + cache read + cache write) for the fixed prompt, under setup-token. */
  tokens: { caseA: number; rebuilt: number };
  /** What a throwaway local server saw, normalized. */
  text: { caseA: Snapshot; rebuilt: Snapshot };
}

export const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'baseline.json');
/** Tokens of difference ignored: the date and tokenizer rounding can move a count by one or two. */
const TOKEN_TOLERANCE = 5;

function normalize(ctx: Ctx, body: CapturedBody): Snapshot {
  const fix = (text: string): string =>
    text
      .replaceAll(ctx.root, '<ROOT>')
      .replace(/(cc_version=\d+\.\d+\.\d+)\.[0-9a-f]+;/g, '$1.<hash>;')
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<DATE>')
      .replace(/OS Version: .*/g, 'OS Version: <OS>')
      .replace(/forkline-regression-[A-Za-z0-9]+/g, 'forkline-regression-<R>');
  return { system: systemBlocks(body).map(fix), messages: flattenMessages(body).map((m) => ({ role: m.role, text: fix(m.text) })) };
}

function firstDifference(label: string, base: Snapshot, now: Snapshot): string | null {
  const blocks = (s: Snapshot): string[] => [...s.system.map((t) => `system: ${t}`), ...s.messages.map((m) => `${m.role}: ${m.text}`)];
  const a = blocks(base);
  const b = blocks(now);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return `${label}: block ${i} differs (baseline ${a[i]?.length ?? 'missing'} characters, now ${b[i]?.length ?? 'missing'}); now: ${quote(b[i] ?? '(none)', 120)}`;
    }
  }
  return null;
}

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;

export function makeCheck11(options: { recordBaseline: boolean }): Check {
  return {
    id: '11',
    title: 'injected text unchanged: total input tokens on a fixed prompt, and the system blocks, against the 0.3.318 baseline',
    cost: 'Haiku x2, tiny prompts',
    async run(ctx) {
      const caseAT = translateChat(ctx, [system('Reply with one word.'), user('Say ok.')]);
      const rebuiltT = translateChat(ctx, [system('Reply with one word.'), user('Hello.'), assistant('Hi.'), user('Say ok.')]);

      const capA = await captureRequest(caseAT, await routerFor(ctx, ctx.captureConfig).route(caseAT), ctx.captureConfig);
      const capR = await captureRequest(rebuiltT, await routerFor(ctx, ctx.captureConfig).route(rebuiltT), ctx.captureConfig);
      const textNow = { caseA: normalize(ctx, capA.body), rebuilt: normalize(ctx, capR.body) };
      for (const [name, snap] of Object.entries(textNow)) {
        const everything = [...snap.system, ...snap.messages.map((m) => m.text)].join('\n');
        assert(!EMAIL.test(everything), `${name}: an email address is in the request (the email reminder is back)`);
      }

      const a = await chat(ctx, caseAT);
      mustReply('case A', a);
      const r = await chat(ctx, rebuiltT);
      mustReply('rebuilt', r);
      const tokens = { caseA: a.totalInput, rebuilt: r.totalInput };

      if (options.recordBaseline || !existsSync(BASELINE_PATH)) {
        const baseline: Baseline = {
          sdk: SDK_VERSION, recordedAt: new Date().toISOString(), model: caseAT.claudeModel, tokens, text: textNow,
        };
        writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
        return `baseline recorded on SDK ${SDK_VERSION}: case A ${tokens.caseA} tokens, rebuilt ${tokens.rebuilt} tokens`;
      }

      const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
      const problems: string[] = [];
      const shift = expected(ctx, 0, 1000);
      for (const key of ['caseA', 'rebuilt'] as const) {
        const delta = tokens[key] - baseline.tokens[key] + shift;
        if (delta > TOKEN_TOLERANCE) problems.push(`${key}: ${tokens[key]} tokens against a baseline of ${baseline.tokens[key]} (grew by ${delta})`);
        else if (delta < -TOKEN_TOLERANCE) problems.push(`${key}: ${tokens[key]} tokens against a baseline of ${baseline.tokens[key]} (shrank by ${-delta}; injected text changed)`);
        const diff = firstDifference(key, baseline.text[key], textNow[key]);
        if (diff) problems.push(diff);
      }
      assert(problems.length === 0, `injected text changed since the ${baseline.sdk} baseline (now SDK ${SDK_VERSION}): ${problems.join(' | ')}`);
      return `case A ${tokens.caseA} (baseline ${baseline.tokens.caseA}), rebuilt ${tokens.rebuilt} (baseline ${baseline.tokens.rebuilt}); system text identical to the ${baseline.sdk} baseline`;
    },
  };
}
