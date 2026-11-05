# Forkline

A small personal server that gives OpenAI-compatible chat clients access to Claude through your own Claude subscription.

Forkline exposes `/v1/chat/completions` and `/v1/models`. Each request is answered by the official Claude Code program, run through the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). It was built for roleplay clients such as [Lumiverse](https://github.com/prolix-oc/Lumiverse), but any client that speaks the OpenAI chat format can use it.

> Forkline is an independent project. It is not made by, endorsed by, or affiliated with Anthropic. "Claude" and "Claude Code" are Anthropic's trademarks.

## Before you use it

- **It is for one person, on their own account.** Anthropic's documentation says subscription limits assume ordinary, individual use, and that developers building products should use API keys. Don't offer a Forkline server to anyone else, and don't build a service on it.
- **Your usage draws on your subscription limits.** Long chats use them quickly.
- **It only ever runs the official, unmodified Claude Code binary.** Forkline contains no patched binaries, makes no direct calls to Anthropic, and doesn't read, refresh or forward OAuth tokens. The token you provide goes to the Claude Code process and nowhere else.
- **It depends on undocumented behaviour.** See [Known limitations](#known-limitations). A Claude Code update can break it, so the SDK version is pinned and there is a regression suite to run before any upgrade.

## How it works

OpenAI clients are stateless: they send the whole conversation every time. Claude Code is stateful: it resumes a session from a transcript. Forkline bridges the two.

```
client ──► HTTP server ──► translator ──► router ──► runner (Claude Code) ──► stream mapper ──► client
```

1. **Translator.** Splits the request into a system prompt, history and the latest user message, and notes anything it had to change.
2. **Router.** Rebuilds the history as a Claude Code session transcript, held in memory for that request. Claude treats earlier replies as its own turns. A request with no history starts a new session.
3. **Runner.** Starts Claude Code with tools, skills, MCP servers and settings files turned off, in an empty folder, with a restricted environment. It checks that the model that answered is the one requested, and maps failures to clear errors.
4. **Stream mapper.** Turns the output into OpenAI chunks, streams reasoning as `delta.reasoning_content`, and enforces `stop` strings.

Forkline rebuilds every request and stores no chats. Prompt caching works on content, so a rebuild that sends the same bytes gets the same cache hits a stored session would. Measured on a 17k-token synthetic chat with Haiku 5.5:

| Action | Prompt read from cache |
|---|---|
| Swipe (identical request) | 100% |
| Next turn, with a lorebook block after the latest message | 84% |
| Edit an earlier message | 48% (the system prompt) |
| Change the preset | 0% |

[docs/task-5-store-design.md](docs/task-5-store-design.md) explains why there is no session store, and when one would be worth adding.

## What it does

- Streaming and non-streaming chat completions.
- Visible reasoning, when the model produces it.
- `stop` strings, enforced on the visible text.
- Images in user messages, as base64 `data:` URLs.
- `reasoning_effort` and `max_tokens` mapping.
- Mid-conversation system messages, kept as real system messages.
- A model guard. If Claude Code serves a different model from the one requested, the request fails instead of quietly substituting.
- Real HTTP errors. The status is held until the model has actually started, so failures before any output are not disguised as a 200.
- Bearer key on every route, and a listen address limited to loopback or a Tailscale IP.
- No message content, API key or token in the logs.

## Nothing changes silently

Forkline forwards what the client sent. Anything it has to change is listed in the `X-Forkline-Adjustments` response header and in the log. Setting `adjustments` to `reject` in the config turns these into a 400 instead, except `system-header-added` and `environment-block-replaced`.

| Adjustment | Meaning |
|---|---|
| `system-header-added` | A short configurable header was added before the client's system text |
| `environment-block-replaced` | Claude Code's environment, model and date text was replaced (see below) |
| `model-defaulted` | The requested model is unknown, so the default was used |
| `<field>-ignored` | A request field has no effect, for example `temperature-ignored` |
| `tools-ignored` | `tools` or `tool_choice` was ignored. Tool calls are never returned |
| `max-tokens-capped` | `max_tokens` was above the model's limit and was lowered |
| `effort-mapped` | `reasoning_effort` of `minimal` or `none` became `low` |
| `trailing-system-moved` | System messages after the last user message were moved in the transcript |
| `system-position-changed` | A system message could not keep its exact position or role |
| `blank-user-dropped` | A blank user message in the history was removed, because the API rejects it |
| `blank-system-dropped` | A whitespace-only system message in the history was removed, for the same reason |
| `reasoning-replay-ignored` | Reasoning resent on an assistant message was ignored |

## What Claude Code adds to the prompt

Claude Code adds its own text to every session. On Claude Code 2.1.318 with a `setup-token` login:

| Text | Where | Status |
|---|---|---|
| A billing metadata line | First system block | Stays |
| `You are a Claude agent, built on Anthropic's Claude Agent SDK.` | Second system block | Stays |
| Environment details: folder, OS, shell | After the latest user message | Replaced on rebuilt chats |
| Model name and knowledge cutoff | After the latest user message | Replaced on rebuilt chats |
| Today's date | After the latest user message | Replaced on rebuilt chats |

The environment text lands right after the latest message, where it can distract the model. Forkline adds Claude Code's own `environment`, `model` and `date` entries to the rebuilt transcript with a zero-width character as their text. Claude Code compares the data in those entries, finds nothing to add, and sends the replacement. That saves about 360 tokens per request and leaves your latest message as the last thing the model reads, apart from any system messages your client put there.

As a result the model doesn't know the date, its working folder, or its exact model name. If your preset needs the date, have your client supply it.

## Requirements

- Node.js 22 (`.nvmrc` holds the exact version)
- A Claude subscription and a token from `claude setup-token`
- Linux. It has been tested on x64 only. Android through Termux is possible but untested: see [deploy/TERMUX.md](deploy/TERMUX.md)

## Quick start

```bash
git clone <this repository> forkline
cd forkline
npm ci
npm run build
```

Create `secrets/forkline.env`, which git ignores:

```bash
FORKLINE_API_KEY=<any random string, at least 16 characters>
FORKLINE_CLAUDE_TOKEN=<output of "claude setup-token">
```

Start the server. It reads `config/forkline.dev.json` and listens on `127.0.0.1:8800`:

```bash
npm start
```

Check that it answers:

```bash
source secrets/forkline.env
curl http://127.0.0.1:8800/v1/chat/completions \
  -H "Authorization: Bearer $FORKLINE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-5-5","messages":[{"role":"user","content":"Say hello."}]}'
```

Then point your client at `http://127.0.0.1:8800/v1` with the same key.

## Configuration

Set `FORKLINE_CONFIG` to the path of a JSON file. `config/forkline.example.json` shows every field.

| Field | Purpose |
|---|---|
| `listen` | Host and port. The host must be loopback or a Tailscale address |
| `models` | The model list, each with `id` and `claudeModel` |
| `defaultModel` | Used when the client sends an unknown model |
| `systemHeader` | Text added before the client's system prompt |
| `thinkingDisplay` | `summarized` or `omitted` |
| `defaultEffort` | Used when the client sends no `reasoning_effort` |
| `adjustments` | `report` or `reject` |
| `concurrency` | Limits on running and queued requests |
| `timeouts` | Idle and overall time limits |
| `limits` | Request body size |
| `paths` | The Claude Code working folder and config folder |
| `retention` | Unused, left over from the dropped session store |
| `debug.captureBodies` | Logs request bodies, including chat text. Leave it off |

Each model can also set these:

| Field | Purpose |
|---|---|
| `maxOutputTokens` | The model's output limit, used to report `max-tokens-capped` |
| `marketingName`, `knowledgeCutoff` | Must match Claude Code's own values exactly, or that model's name and cutoff line stays in the prompt |
| `foldsSystemMessages` | Set for models where Claude Code turns system messages into user text |

## API

| Route | Purpose |
|---|---|
| `POST /v1/chat/completions` | Chat, streaming or not |
| `GET /v1/models` | The configured models |
| `GET /health` | Status, active and queued requests, and the latest subscription usage |

Every route needs `Authorization: Bearer <FORKLINE_API_KEY>`. Errors look like this, with `code` holding the HTTP status:

```json
{ "error": { "message": "...", "type": "usage-limit", "code": 429 } }
```

## Known limitations

**Undocumented behaviour**
- Rebuilding sessions relies on the SDK's `sessionStore` option, which is marked alpha, and on a transcript format that isn't documented.
- Replacing the environment text relies on Claude Code internals. If that stops working, the text comes back and costs about 360 tokens per request. Chats keep working.
- The replacement only applies when Forkline's values match Claude Code's exactly. A mismatch has the same safe result.

**Model behaviour**
- Fable 5.1, Fable 5, Opus 5.5, Opus 5, Sonnet 5.5 and Haiku 5.5 have safety classifiers that can decline harmless requests. The client sees `finish_reason: content_filter` and no reply. The log has a `model refused` line with the category.
- `reasoning_extraction` is a common cause with roleplay presets. It fires on prompts that ask the model to write its thinking or plan into the reply. Remove that instruction, and use the reasoning Forkline already streams.
- A short note arriving alone after the latest message can be ignored. In testing, a one-sentence note in that position was often missed, while a realistic lorebook of 13 entries was used every time. Headings help.

**Message layout**
- In the request, a system message can only sit right after a user message. One placed directly before a user message lands just after it, and `system-position-changed` reports this.
- On Opus 4.7 and earlier, Sonnet 4.6 and 4.5, and Haiku 4.5, Claude Code turns system messages into user text in front of the latest message.
- With a system message before any user message, Claude Code adds an assistant turn saying `No response requested.`.
- The first message of a chat with no history keeps the environment text.

**Parameters and models**
- `temperature`, `top_p`, `seed` and other sampling fields have no effect. Claude Code offers no such controls.
- `n` above 1, `response_format`, tool calls and assistant prefill are rejected with a 400.
- A reply that runs over `max_tokens` is an error, not a cut-off reply, and thinking counts towards the limit.
- Remote image URLs are never fetched.
- Fable models need usage credits. Without them, requests return a 429.
- Compaction is off, so a chat that outgrows the context window should fail with a clear error. It is never silently rewritten. This hasn't been tested end to end.

**Clients**
- Client token counters can read low. Claude 4.7 and later models use a tokenizer that produces about 30% more tokens for the same text.
- Forkline has only been tested with Lumiverse.

### Where to put lorebook entries

Everything after a change in the prompt has to be rewritten to the cache, so placement matters. Measured on a 17k-token synthetic chat with Haiku 5.5:

| Placement | Cached, same lorebook | Cached, one entry changed |
|---|---|---|
| With the system prompt | 100% | 0% |
| Right after the greeting | 100% | 47% |
| After the latest message | 84% | 84% |
| After the previous user message | 47% | 47% |

Constant entries work best near the top. Entries that change suit the end, where the cost stays flat as a chat grows.

## Deployment

The `deploy/` folder holds an install script, a hardened systemd unit and a runbook for a VPS on Tailscale. Follow [deploy/RUNBOOK.md](deploy/RUNBOOK.md). The pack has passed syntax and unit checks but has not yet been run on a real server.

To run it on an Android phone beside your client, with no server, see [deploy/TERMUX.md](deploy/TERMUX.md). That route is untested.

Never expose Forkline to the public internet. It drives a program on your server with your subscription.

## Development

```bash
npm test             # unit tests, no Claude calls
npm run typecheck
npm run test:live    # real calls on Haiku
npm run regression   # real calls, including one per configured model
```

`test:live` and `regression` use your subscription. Run the regression suite before changing the SDK version in `package.json`. It checks the behaviour this project depends on, including that the injected text is still replaced.

| Path | Contents |
|---|---|
| `src/translator/` | OpenAI request to internal form |
| `src/transcript/` | Session transcript entries |
| `src/router/` | Chooses how a request starts, and seeds the session |
| `src/runner/` | Runs Claude Code, guards and error mapping |
| `src/stream/` | SSE and JSON output, stop strings |
| `src/http/` | Server, auth, queue |
| `tools/regression/` | Live checks against the real engine |
| `fixtures/` | Invented requests and expected output |
| `deploy/` | Install script, systemd unit, runbook |

Tested with Agent SDK 0.3.318, which bundles Claude Code 2.1.318.

## Prior work

Two projects showed that bridging a client to Claude Code is workable: [SillyTavern-ClaudeSubscription](https://github.com/LukaTheHero/SillyTavern-ClaudeSubscription) and [claude-code-sillytavern-bridge](https://github.com/MissSinful/claude-code-sillytavern-bridge). Forkline uses no code from either.

## License

Forkline is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). Personal, hobby and other noncommercial use is allowed, including changing and sharing the code under the same terms. Commercial use is not allowed. This is not an open source license in the usual sense.

The license covers Forkline's own code. The Claude Agent SDK and Claude Code have their own terms, and Anthropic's terms apply to how you use your account whatever this license allows.

Required Notice: Copyright 2026 Innsaute-Glitch
