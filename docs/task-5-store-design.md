# Task 5 archive: the session store we didn't build

Dropped on 2026-11-05. This keeps the design, the evidence and the conditions for revisiting it.

## What it was
A SQLite store for Claude Code sessions, plus an index of message hashes. A request matching stored history would resume a session (case B) or fork it (case C) rather than rebuild it (case D). The aim was cheap swipes and edits. It also brought per-session locks, retention and cleanup of local copies.

## Why it was dropped
Prompt caching works on content, not on sessions. A rebuild that sends the same bytes gets the same cache hits as a stored session, so the store had nothing to add. Measured on Haiku 5.5, 17k-token synthetic chat, SDK 0.3.318, `setup-token`, plain rebuilds, one run each:

| Action | Injected text removed | Injected text present |
|---|---|---|
| Swipe (identical request) | 100% cached | 100% cached |
| Next turn, lorebook moved | 84% | 82% |
| Edit, recent or early | 48% (system prompt only) | 47% |
| Changed preset | 0% | 0% |

Sonnet 5.5 showed the same pattern in the phone test log. Dropping it also means no chat copies in a database, and much less undocumented behaviour to depend on.

An earlier claim that the environment-block removal caused this caching was wrong: the table shows caching is the same either way. Earlier research measured a rebuilt turn caching only the system prompt (about 2,950 tokens written on a 3k chat). That wasn't reproduced here, and the reason wasn't found. The older test used a normal login and a different setup.

## If Anthropic closes the injected-text workaround
**The store is not the fix.** If `buildSeedEntries` stops working, the environment, model and date text returns at the end of each request, which is confusing but harmless to caching (right-hand column), and costs about 360 tokens per request. Regression check 14 will fail, and that is the signal.

Try these first, in order:
1. Seeds without `rendered`. In testing this moved the block to the earlier slot we seeded it in, away from the latest turn.
2. Check whether new SDK options or documented settings cover it.
3. Stay on the last SDK version that works, for as long as its models are served.

## When the store would be worth revisiting
- Regression check 6 fails: repeat requests stop being cached, so rebuilds become expensive.
- Sessions start to hold something a rebuild can't recreate. Rebuilt history is text only.
- Claude Code stops accepting seeded transcripts through `sessionStore`, which `@alpha` allows at any time. A store of real sessions would then be the only way to carry history, and case D, the core of this project, would need replacing.

Measure first: run the cache test above before and after. The store only helps if it sends different bytes from a rebuild, or if rebuilds stop working.

## Known risks of the design
- Lumiverse's normal turns can never continue a stored session, because the lorebook moves to the new end each turn. Only swipes and edits would use it.
- Fork cut point: the last entry before the live user entry, or the same user message is sent twice. Never verified live. The SDK's guidance agrees: fork at the kept turn's last chain entry.
- `route` must run under the lock, and failed runs must not be indexed. Seed sessions as `fork` and promote them in `record`.
- `finished` already waits for the SDK iterator, so entries are stored before `record`.
- A store keeps private chat text on disk, so it needs retention.

## Still in the code
The B and C types, `lockKey`, the limiter's lock path (tested) and the `router.record` no-op. Task 5 could be built without changing HTTP code.

---

## Original contract text

### Session and store rules
- **Store keys:** adapters key on `sessionId` only and ignore `projectKey`, because `query()` derives that value internally. Session IDs are UUIDs and there is one `cwd`. For a `key.subpath`: `append` is a no-op and `load` returns null.
- **`append`:** keep entries in call order. De-duplicate by `uuid` when present. **Always append entries that have no `uuid`.**
- **`load`:** return `null` for an unknown session.
- **`query` options per case.** The SDK rejects `sessionId` together with `resume` unless `forkSession` is set, so the runner passes `sessionId` only for A and C:

| Case | When | `resume` | `sessionId` | `forkSession` | `resumeSessionAt` |
|---|---|---|---|---|---|
| A | `history` is empty | not passed | `plan.sessionId` | not passed | not passed |
| B | `history` equals a stored session's whole sequence, reply included. Lumiverse's normal turns don't reach this | stored session (`plan.sessionId === plan.resume`) | not passed | not passed | not passed |
| C | The request matches a stored prefix, or repeats a stored request (a swipe) | source session | new session | `true` | the cut |
| D | Anything else; entries are seeded before `route` returns (`plan.sessionId === plan.resume`) | seeded session | not passed | not passed | not passed |

- **Injected text:** on every rebuilt session the router appends `buildSeedEntries` after the history: Claude Code's own `environment`, `model` and `date` attachments, each with `renderedRole: 'system'` and `INJECTED_TEXT_FILLER` as `rendered`. Claude Code then treats that text as already sent, and the filler replaces it. Adjustment `environment-block-replaced`, reported whenever `history` is non-empty and exempt from `adjustments: "reject"`. Case A stays unseeded, because seeding would add a made-up `No response requested.` turn.
- **Seeds must match exactly:** the environment snapshot (real working directory, platform, shell, OS version), the local date, and the model's `claudeModel`, `marketingName` and `knowledgeCutoff` from config. On a mismatch Claude Code injects its own text again, which is safe. A model with no name and cutoff in config keeps its model line. `shell` is always `bash`, because the env allow-list withholds `SHELL`.
- **Fork cut point:** the **last entry before the live user entry**, which is the kept turn's last entry. A swipe re-sends the same user message as the live prompt, so the cut must not include it. A case A session has no entry before the live user entry, so it has no cut: repeating that request is simply a new case A.
- **Index identity:** hash the **translated** sequence: `history`, then `livePrompt`, then the reply. Each item is canonical JSON of `{ role, content }`. Assistant replies hash `replyText`. The model is part of the key. The system prompt is not.
- **`record` runs only** after `finishReason: 'stop'`. It is skipped for stop-truncated, refused, failed or disconnected runs. For a session where an `append` failed, which the store tracks itself, `record` does nothing. Those turns route to D next time.
- **Retention kinds:** every session starts as `fork`, including seeded ones, so runs that never reach `record` expire quickly. `record` promotes sessions from A, B and D to `head`; sessions from C stay `fork`. TTLs run from last use, and forking counts as a use of the source session.
- **Local copies:** the SDK always writes a local transcript under `CLAUDE_CONFIG_DIR` and materializes a temporary JSONL on resume. The retention job also deletes files under `<configDir>/projects` older than `retention.forkTtlMinutes`. Task 5 finds where the temporary JSONL is written and cleans that too if it can outlive the run.

## Original task entry

## Task 5: Persistent store and index            [complex]
Depends on: the gate
Owns: `src/store/`, `src/router/`
Dev port: 8802

Accepts:     `TranslatedRequest`, `RouteRecord`
Produces:    SQLite `SessionStore`, `Router` v1, retention sweep
Does:        §3.1 session and store rules; longest-prefix lookup picking B, C or D; `lockKey`; retention job with local-copy cleanup; tracking failed `append` calls so those sessions are never indexed. **First**, measure on Haiku with a history of at least 3k tokens, because prompts near 700 tokens showed no cache reads : the fork cut point with seeds as the last entries, and that the fork stays free of injected text; the fork cut point on a swipe (one copy of the user message, full cache); C fork plus extra rebuilt entries; whether an edit gains any cache over D.
Does NOT:    no changes to translator, runner or HTTP code. If one is needed, report it.
Tools:       `better-sqlite3`, WAL mode.
Done-check:  a swipe shows `cache_read_input_tokens` covering the history and `cache_creation_input_tokens` near 0, with one copy of the user message; an edit routes to C if it measured a gain, else D, with the numbers reported; sessions survive a restart; expired rows and old local files are removed; concurrent calls on one session serialize; a killed process leaves a usable store; a failed `append` leaves the session unindexed; a seeded session whose run failed expires on the fork TTL.
