// Check 13: every configured model is served as requested, on a rebuilt chat through the seeded path.
import { captureRequest, flattenMessages } from '../capture.js';
import {
  Skip, assert, chat, expected, has, isCreditsMessage, quote, routerFor, system, translateChat, user, assistant,
  type Ctx,
} from '../harness.js';
import type { Check } from './types.js';

const ZERO_WIDTH = '​';

/** Where the seeded filler lands in a request, found by capture so no model names are hard-coded. */
function fillerLayout(body: ReturnType<typeof flattenMessages>): string {
  const live = body.map((m, i) => (m.role === 'user' && m.text.includes('What was the password') ? i : -1)).filter((i) => i >= 0).at(-1) ?? -1;
  if (live < 0) return 'live message not found';
  const inLive = body[live]!.text.includes(ZERO_WIDTH);
  const after = body.slice(live + 1).some((m) => m.text.includes(ZERO_WIDTH));
  const before = body.slice(0, live).some((m) => m.text.includes(ZERO_WIDTH));
  if (inLive) return 'filler in front of the live user message';
  if (after && !before) return 'filler in a system message after the live message';
  if (before) return 'filler before the live message';
  return 'no filler in the request';
}

export const check13: Check = {
  id: '13',
  title: 'each configured model is served as requested (model guard), on a rebuilt chat',
  cost: 'one small call per configured model',
  async run(ctx: Ctx) {
    const failures: string[] = [];
    const skipped: string[] = [];
    let passed = 0;
    for (const model of ctx.config.models) {
      const t = translateChat(
        ctx,
        [
          system('Answer in one word.'),
          user('The password is pelican.'),
          assistant('Understood.'),
          user('What was the password? One word.'),
        ],
        { model: model.id },
      );
      // Where this model puts the seeded filler: found locally, free.
      let layout = 'layout not captured';
      try {
        const cap = await captureRequest(t, await routerFor(ctx, ctx.captureConfig).route(t), ctx.captureConfig);
        layout = fillerLayout(flattenMessages(cap.body));
      } catch (cause) {
        layout = `layout capture failed: ${(cause as Error).message}`;
      }
      const result = await chat(ctx, t);
      if (result.error) {
        if (result.error.code === 'usage-limit' && isCreditsMessage(result.error)) {
          skipped.push(model.id);
          ctx.note(`${model.id}: skipped: needs usage credits`);
          continue;
        }
        failures.push(`${model.id}: ${result.error.code} (${result.error.status}): ${quote(result.error.message, 140)}`);
        ctx.note(`${model.id}: FAILED ${result.error.code}: ${quote(result.error.message, 100)}; ${layout}`);
        continue;
      }
      const word = expected(ctx, 'pelican', 'albatross');
      const recalled = has(result.text, word);
      const served = result.startedModel ?? '(none)';
      ctx.note(`${model.id}: served as ${served}, ${result.finishReason}, recall ${recalled ? 'yes' : 'NO'}; ${layout}`);
      if (!recalled) failures.push(`${model.id}: served as ${served} but did not recall the password through the seeded path: ${quote(result.text, 80)}`);
      else passed++;
    }
    assert(failures.length === 0, `${failures.length} model(s) failed: ${failures.join(' | ')}`);
    if (passed === 0 && skipped.length > 0) throw new Skip('skipped: needs usage credits (every model)');
    return `${passed} served as requested${skipped.length ? `; ${skipped.length} skipped: needs usage credits (${skipped.join(', ')})` : ''}`;
  },
};
