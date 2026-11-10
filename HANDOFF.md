# Forkline handoff

Read this first if you are a new session or a new agent. It should be enough to start work from a fresh clone. `README.md` covers what the project is and how to run it; this file covers how the project is kept working, and why it is the way it is.

**Keep this file current.** At the end of any piece of work, update [Current state](#current-state), [Open items](#open-items) and anything else that changed. Keep it safe to publish: it is in a public repository, so no private chat content, IP addresses or secrets.

## Current state

Last updated 2026-11-10.

- **Status:** v0 is finished and passed a real phone test through Lumiverse on Sonnet 5.5: edits, swipes, continue, stop mid-reply, reasoning display, cache reads and system prompt changes. That test was on engine 0.3.318 and has not been repeated since the upgrade.
- **Tests at last run (2026-11-10, engine 0.3.322):** 290 unit tests, 9 live tests and 16 regression checks, all passing. Check 13 served all 15 configured models as requested, including Fable 5.2, 5.1 and 5, which were no longer rejected for credits.
- **Engine:** Agent SDK 0.3.322, which bundles Claude Code 2.1.322. The pin is exact. Upgraded from 0.3.318 to add Fable 5.2 (`claude-fable-5-2`). The only change in the injected text was the version number in the billing line, so the check 11 baseline was recorded again.
- **Not done yet:** the VPS deployment. `deploy/` has never run on a real server.
- **License:** PolyForm Noncommercial 1.0.0. Say "source-available", never "open source".

## Rules from the owner

These are decisions, not suggestions. Don't change them without asking.

1. **Only the official, unmodified Claude Code binary talks to Anthropic.** No raw API calls, and no reading, refreshing or forwarding OAuth tokens in bridge code. The only exception is passing the token into the subprocess environment.
2. **Never put a patched or modified Claude Code binary in this repo, and never run one under Forkline.** This is what separates the project from tools that break the terms and risk account bans. On the developer side, reading the binary to understand it and running whatever tests a bug needs are fine.
3. **Send as-is, never silently change.** Forkline forwards what the client sent. Every change is a reported adjustment.
4. **Cache is the client's job.** Never reshape a request to improve caching.
5. **Rebuilding from the client's history is the core design.** There is no "flatten history into text" fallback anywhere.
6. **Single user, text only, tools off.** Never offer this to other people.
7. **Reasoning is shown** when the model produces it.
8. **Never set `fallbackModel`.** Use full model ids. The guard accepts the requested id, or that id plus `-YYYYMMDD`, and nothing else.
9. **Never log** message content, the API key or the token. `debug.captureBodies` is the only exception, and it is off.
10. **Live calls:** Haiku (`claude-haiku-5-5`) freely, but keep prompts small. An agent once sent a 414k-token prompt, and that burned real limits. Other models only for the check that each model is served as requested, or with the owner's OK. Stop on a usage-limit error rather than retrying.
11. **Ask first** before anything costly or public: pushing, touching the VPS, or sending anything outside this machine.
12. **Never put private content in tracked files.** Fixtures are invented. No real chat text, character names, IP addresses or secrets.
13. **Keep the README general.** Roleplay is the owner's own use case, so public docs describe a general chat bridge.
14. **Write plainly.** The owner dislikes stock AI phrasing, and specifically the word "caveats".

## Files you may not have

These are gitignored and exist only on the owner's machine. A fresh clone doesn't have them, and everything needed from them is summarised here.

| File | Contents |
|---|---|
| `CLAUDE.md` | Short agent rules. Loaded automatically on the owner's machine |
| `plan.md` | The full contract and task history |
| `plan-brief.md` | Decisions and measurements. Section 18 is the most current |
| `research-notes.md` | The original research log. Contains private details |
| `notes.md`, `tasks/` | Agent questions, task plans and reports |
| `secrets/forkline.env` | `FORKLINE_API_KEY` and `FORKLINE_CLAUDE_TOKEN`. Never print it |
| `tools/captures/` | Private chat captures. Never open it |
| `reference/` | Cloned reference projects. Never open `reference/SillyTavern-ClaudeSubscription/`, which is AGPL. `reference/Lumiverse/` is read-only, for checking client behaviour; copy nothing |

If those files exist, add new findings to `plan-brief.md` as well as here. If they don't, this file is the record.

## Layout

| Path | Job |
|---|---|
| `src/translator/` | Request to `TranslatedRequest`: system split, trailing system move, blank handling, parameters, adjustments. Pure |
| `src/transcript/` | `buildEntries` (history to transcript entries) and `buildSeedEntries` (the injected-text replacement). Pure |
| `src/router/` | Picks case A or D, seeds a per-request in-memory store, works out seed facts |
| `src/runner/` | `run()`, query options, env allow-list, model guard, outcome mapping, rate limits, transcript cleanup |
| `src/stream/` | SSE and JSON output, stop scanner. No I/O |
| `src/http/` | Fastify server, bearer check, limiter, the request flow |
| `src/constants.ts` | The only place for adjustment names, headers, env var names and the SDK version |
| `src/errors.ts` | Error codes and statuses |
| `src/types.ts` | Shared types |
| `config/` | Dev and example configs. Models live only here |
| `fixtures/` | Invented requests, run events and golden output |
| `tools/regression/` | Live checks. Run before any engine upgrade |
| `deploy/` | Install script, systemd unit, VPS runbook, and `TERMUX.md` for Android |
| `docs/task-5-store-design.md` | The dropped session store: why, and when to revisit it |

Toolchain: Node 22 (`.nvmrc`), TypeScript ESM, so relative imports end in `.js`. Tests sit in a `test/` folder beside the code: `*.test.ts`, or `*.live.test.ts` for real calls. Golden tests read `fixtures/golden/`, never live config.

## Commands

```bash
npm test             # unit tests, free
npm run typecheck
npm run build
npm start            # dist/main.js, loads secrets/forkline.env, port 8800
npm run test:live    # real Haiku calls
npm run regression   # real calls, one per configured model. About 3 minutes, 36 runs
```

`npm run regression -- --only N`, `--skip N`, `--list`, `--record-baseline` and `--wrong N` are available. `--wrong N` proves a check can fail.

## Request flow

1. Check the bearer key, then `translate`. A failure returns its error as JSON.
2. The limiter takes a slot, or returns `queue-full` (503).
3. `router.route` returns a plan, with the session seeded.
4. Take `plan.lockKey` if it isn't null. It is always null today.
5. `run()` starts, and HTTP pulls the **first event before sending anything**:
   - `error` with `session-stale`: route again with `forceRebuild` and run once more.
   - any other `error`: send that status as JSON.
   - `started`, streaming: send 200, then stream the whole sequence.
   - `started`, non-streaming: wait for `toCompletion`, then use its real status.
   - no event, which means an abort: send nothing.
6. A stop match or a client disconnect aborts the `signal`.
7. `router.record` is a no-op today.
8. One `finally` on every path releases the slot and writes one `request` log line. `onDone` doesn't fire on early paths, so nothing there may depend on it.

## Rules the code must keep

**Runner**
- The first event is `started` or `error`. Exactly one `finished` or `error` ends the run, except that an aborted run ends with no terminal event.
- `started` fires on the first `message_start`, after the model guard passes.
- `finished` fires only after the SDK iterator ends, because the last transcript entries arrive 0.8 to 0.9 s after `result`.
- Reply text comes **only** from `stream_event` deltas. Never read it from `assistant` or `result` messages.
- A good result's `result` field is never used as error text. A reply saying "No conversation found" once turned into an error that way.
- The runner never retries. A failed run leaves the user's message in the session, so a second run would send it twice. Claude Code retries API errors itself. The only retry is the `session-stale` reroute, on a fresh session.

**Outcome mapping** (`src/runner/outcome.ts`) is ordered: the first match wins.
- Refusals come first, because a real refusal also sets `is_error: true`.
- `is_error: true` is an error whatever the subtype, and so is a non-`success` subtype.
- `<synthetic>` text is never a reply.
- A successful result with no text is an error.
- An assistant error frame followed by a good reply doesn't count.

**Query options:** `tools: []`, `skills: []`, `settingSources: []`, `mcpServers: {}`, `strictMcpConfig: true`, `verbatimPrompts: true`, `maxTurns: 1`, `permissionMode: 'dontAsk'`, `includePartialMessages: true`, and a custom system prompt with `snapshot: false`. Pass `sessionId` only for case A: the SDK rejects it with `resume` unless `forkSession` is set.

**Subprocess environment** is an allow-list: `PATH`, `HOME`, `LANG`, `TZ` and what Forkline sets. The SDK's `env` option replaces the environment rather than merging it. Nothing named `FORKLINE_*` or `ANTHROPIC_*` may reach it.

**Adjustment header:** client field names can reach it through `<field>-ignored`, so values are made header-safe in `adjustmentsHeader`. An illegal value throws after the run has started.

## Things that were hard to learn

Each of these took measurement. Trust them over intuition, and re-measure after an engine upgrade.

**Removing the injected text.** Claude Code adds environment, model and date text once per session, right after the latest user message. It decides by comparing the structured `attachment` data in the transcript, not the text. So `buildSeedEntries` adds its own `environment`, `model` and `date` entries, and Claude Code adds nothing.
- The `rendered` field replaces what the model sees. It can't be empty, because that falls back to the default text, and spaces get a 400 from the API, so it holds one zero-width character.
- `renderedRole` only picks the role where the model allows it. It is not what makes this work.
- The data must match exactly: real working directory, platform, shell, OS version, today's local date, and the model's id, `marketingName` and `knowledgeCutoff`. A mismatch is safe: Claude Code injects again, and a wrong folder adds an `# Environment update` message.
- `shell` is `zsh` if `zsh` is anywhere on `PATH`, otherwise `bash`, because the allow-list withholds `SHELL`.
- Seeded system entries use a `session_context` attachment, not `date`. A `date` entry made Claude Code announce a changed date when UTC and local dates differed.
- Case A stays unseeded, because seeding would add a made-up `No response requested.` turn.
- The billing and identity lines are in the system prompt, and this doesn't reach them.

**Caching.** It works on content, not sessions, so a rebuild gets the same hits a stored session would. On 17k tokens: swipe 100%, next turn 82 to 84%, edit 47 to 48% (the system prompt only), changed preset 0%. This doesn't depend on the injected-text removal. An early research note said rebuilds cached only the system prompt; that couldn't be reproduced, and the reason is unknown.

**System message positions.** In the request, a system message only exists right after a user message.
- One that follows a user message stays.
- One directly before a user message lands right after it.
- With no user message before it, Claude Code wraps it as a user message in `<system-reminder>` tags and adds `No response requested.`.
- Opus 4.7, 4.6, 4.5, Sonnet 4.6, 4.5 and Haiku 4.5 fold system entries into the user message in front of the live message. `claude-sonnet-5` wraps each entry in `<system-reminder>` tags.
- Twelve entry formats were tried and none keeps a slot directly before a user message without something worse. `system-position-changed` reports these cases.
- The lorebook's position depends on the client's preset, so never assume it is at the end.

**Short notes after the latest message can be ignored.** One short plain sentence alone in that slot: Haiku 1/5, Sonnet 5.5 0/5. With a `###` heading, 5/5 on both. In a 13-entry lorebook, 15/15. Two messages up, 15/15. More text in the same message helps, and the real environment block used to do that by accident. The owner decided to leave this: it is a model matter.

**Refusals.** Fable, Opus 5 and 5.5, Sonnet 5.5 and Haiku 5.5 have safety classifiers separate from the model. A refusal arrives as `model_refusal_no_fallback` plus `stop_reason: 'refusal'` plus `is_error: true`, with no text, and Forkline reports `content_filter`. `reasoning_extraction` fires when a preset asks for thinking or a plan in the reply; the fix is in the preset. The `model refused` log line has the category.

**Continue.** Lumiverse's real Continue action ends on the assistant reply, then a system nudge, with no user message. A resumed turn must end on a user message, so the translator keeps the reply in history and sends the last system message as the live prompt, reported as `continue-nudge-as-user`. A plain assistant prefill with nothing after it is still a 400. A zero-width user message plus the system nudge was tested instead: the API accepted it, but all 5 Haiku replies began "Mira's voice trailed off" and dropped the sentence, while the nudge as a user message mostly finished it. Lumiverse's Empty Send Nudge is a different path: a user message, which must not be blank or the chat ends on an assistant message and gets a 400.

**Lumiverse.**
- It treats `length` and `content_filter` as failed generations, and it fails a stream with no `finish_reason`. So stop-string matches end with `stop`.
- It reads a numeric `error.code` as the status.
- Its Claude tokenizer predates Opus 4.7, so it counts about 25 to 30% low.
- It can't resolve MagicDNS names, so it needs the Tailscale IP.
- It sends `model: "none"` until a model is picked.
- Roleplay text runs about 2.9 characters per token, so the usual divide-by-4 estimate is low.

**Local files.** Resumed sessions run from `/tmp/claude-resume-*`, which the SDK removes once the subprocess exits, so a folder stays if Forkline dies first. The server clears its own at startup. Case A leaves a transcript under `<configDir>/projects`, which the runner deletes after the run and again 10 s later, because an aborted process takes about 3 s to exit.

## Testing without spending usage

To see the exact request Claude Code builds, point `ANTHROPIC_BASE_URL` at a throwaway server on `127.0.0.1` with a dummy `CLAUDE_CODE_OAUTH_TOKEN`. Record the body, return a 400, and forward nothing. `tools/regression/capture.ts` does this. Claude Code retries after a 400, so expect several identical requests. Never send the real token there. A capture isn't a real API call, so confirm anything important on Haiku afterwards.

Test with enough runs. Several conclusions here were wrong after one or two runs, and small invented notes behave differently from a real lorebook.

## Decisions already made

Don't reopen these without new evidence.

| Decision | Why |
|---|---|
| No session store | Caching works on content, so a store adds nothing. See `docs/task-5-store-design.md` |
| TypeScript Agent SDK, not the CLI | Forking, reasoning and transcripts are public options there |
| SDK pinned at a current version | Older versions inject less, but can't use current models |
| `verbatimPrompts: true` | Otherwise `/help` is intercepted and `/init` is replaced by a hidden prompt |
| Whitespace-only history system entries dropped | The API returns 400. An empty `""` is kept |
| Short-note behaviour left as it is | A model matter. Sending notes as user text would change the client's role |
| `No response requested.` accepted | Only chats with no greeting, and it comes from Claude Code |
| Runner never retries | A second run would duplicate the user's message |
| PolyForm Noncommercial | Blocks paid relays. A free relay is still barred by Anthropic's terms, not by the license |

## Open items

- **VPS deployment.** The owner follows `deploy/RUNBOOK.md`. Agents never connect to the VPS. Still unverified there: `setup-token` auth, the hardened unit, and whether the injected text stays gone and the email reminder stays absent.
- **Termux.** `deploy/TERMUX.md` covers running on Android inside `proot-distro` Ubuntu. It has never been run, so arm64, `proot` speed, seeds matching inside `proot` and Android killing the process are all unknown. Plain Termux can't work because Claude Code has no Android build, and patching the binary to load there is ruled out by the owner's rule 2.
- **The owner's main preset** has planning instructions that trigger `reasoning_extraction`. They plan to rework it.
- **Fable models** ran the seeded path for the first time on 2026-11-10: one small rebuilt chat each in check 13, with correct recall, plus a local capture showing no injected text for Fable 5.2 and 5.1. Nothing longer has been tried on them, and why the credits rejection stopped is unknown.
- **Never seen live:** a context-too-long error, a real usage-limit rejection, a refusal arriving mid-reply. The unit of `resetsAt` is assumed to be seconds.
- **A whitespace-only assistant entry** in history has no rule. It may get a 400.
- **Session-title side request:** Claude Code sometimes sends one beside the main call. Its effect on limits is unmeasured. The `title` option may avoid it, but that is untested.
- **The idle timer** keeps running while a slow client holds the stream, so a stall over 90 s would report `no output from Claude Code`.
- **Unused code left in place:** the `retention` config, `lockKey` and the limiter's lock path, the B and C route cases, and `router.record`.
- **Update the README** after deploying: the deploy note and "only tested with Lumiverse".

## Upgrading the engine

1. Change the exact pin in `package.json` and `SDK_VERSION` in `src/constants.ts`.
2. Run `npm run regression`. Check 14 fails if the injected text returns, check 6 if caching changes, and check 11 if the injected text grows.
3. If check 11 changed for an understood reason, run `--record-baseline`.
4. A new model needs `marketingName`, `knowledgeCutoff` and `maxOutputTokens` in config, plus `foldsSystemMessages` if Claude Code folds its system messages.
5. If check 14 fails, see "If Anthropic closes the injected-text workaround" in `docs/task-5-store-design.md`. A store is not the fix.

## Working style

- Read the code before changing it, and match its patterns. No features or refactors beyond the request.
- For a bug: reproduce it with a failing test, fix it, then run `npm test` and `npm run typecheck`. Use the regression suite for anything touching the runner, router or transcript.
- If a test result seems too good, check it with a harder case. Report results honestly, including ones that overturn an earlier claim.
- Scan for secrets before any push. Commit only when the owner asks.
