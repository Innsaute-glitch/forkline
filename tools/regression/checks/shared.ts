// Runs shared by more than one check, so a live call is made once.
import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { chat, routerFor, translateChat, user, assistant, system, type Chat, type Ctx } from '../harness.js';

export const FIRST_MESSAGE = 'The lantern code is MARIGOLD-7741, please remember it.';

export interface RebuiltRun {
  result: Chat;
  /** Store contents after the router seeded the session, before Claude Code ran. */
  before: SessionStoreEntry[];
  after: SessionStoreEntry[];
}

let memo: Promise<RebuiltRun> | undefined;

/** The 3-turn rebuilt chat of check 1, which check 14 inspects afterwards. */
export function rebuiltThreeTurns(ctx: Ctx): Promise<RebuiltRun> {
  memo ??= (async (): Promise<RebuiltRun> => {
    const translated = translateChat(ctx, [
      system('You are a ferryman named Bram. Keep replies short.'),
      user(FIRST_MESSAGE),
      assistant('Noted, I will remember the lantern code.'),
      user('Which river do we cross at dawn?'),
      assistant('We cross the Veldt at dawn, as always.'),
      user('Bring the red oars.'),
      assistant('The red oars are already aboard.'),
      user(
        'Reply in exactly two lines. Line 1: my very first message in this chat, word for word, in quotes. Line 2: only the word YES if you wrote the assistant replies above, or NO if you did not.',
      ),
    ]);
    const plan = await routerFor(ctx).route(translated);
    const key = { projectKey: '', sessionId: plan.sessionId };
    const before = (await plan.sessionStore.load!(key)) ?? [];
    const result = await chat(ctx, translated, plan);
    const after = (await plan.sessionStore.load!(key)) ?? [];
    return { result, before, after };
  })();
  return memo;
}
