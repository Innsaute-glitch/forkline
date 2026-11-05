# Running Forkline on Android with Termux

This runs Forkline on the same phone as your client, so you need no server and no laptop. Your client connects to `127.0.0.1` on the phone.

**This setup is untested.** Forkline has only been run on Linux x64. Expect to fix things, and see [What to check](#what-to-check) for how to tell if it is working.

**Why Ubuntu inside Termux?** Claude Code has no Android build, and its Linux build can't run directly on Android. `proot-distro` gives you an Ubuntu environment inside Termux, where the official Linux arm64 build runs unchanged. Some guides patch the binary so it loads on Android instead. Don't do that here: Forkline only ever runs the official, unmodified binary.

## What you need

- A 64-bit (arm64) Android phone
- About 3 GB of free storage
- Plenty of free memory. Each reply starts a Claude Code process of about 340 MB
- [Termux from F-Droid](https://f-droid.org/packages/com.termux/). The Google Play version is out of date
- A token from `claude setup-token`. Generate it on a computer that has Claude Code signed in, or see [step 5](#5-add-your-secrets)

## 1. Set up Ubuntu

In Termux:

```bash
pkg update && pkg upgrade
pkg install proot-distro
proot-distro install ubuntu
proot-distro login ubuntu
```

Your prompt changes to `root@localhost`. Every command from step 2 to step 6 runs inside Ubuntu.

## 2. Install the basics

```bash
apt update
apt install -y ca-certificates curl git xz-utils
```

## 3. Get Forkline

```bash
cd ~
git clone https://github.com/Innsaute-glitch/forkline.git
cd forkline
```

## 4. Install Node 22

Forkline needs Node 22, and Ubuntu's own package may be a different version. This installs the exact version in `.nvmrc` and checks the download:

```bash
V=$(tr -d 'v \r\n' < .nvmrc)
F=node-v$V-linux-arm64.tar.xz
cd /tmp
curl -fsSLO https://nodejs.org/dist/v$V/$F
curl -fsSLO https://nodejs.org/dist/v$V/SHASUMS256.txt
grep " $F\$" SHASUMS256.txt | sha256sum -c -
tar -xJf $F -C /usr/local --strip-components=1
rm $F SHASUMS256.txt
cd ~/forkline
node --version
```

The checksum line must say `OK`, and the last command should print the version from `.nvmrc`.

Now install and build. This step can take several minutes under `proot`:

```bash
npm ci --no-audit --no-fund
npm run build
```

## 5. Add your secrets

```bash
mkdir -p secrets
chmod 700 secrets
KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
printf 'FORKLINE_API_KEY=%s\nFORKLINE_CLAUDE_TOKEN=\n' "$KEY" > secrets/forkline.env
chmod 600 secrets/forkline.env
```

Open `secrets/forkline.env` and paste your token after `FORKLINE_CLAUDE_TOKEN=`:

```bash
apt install -y nano
nano secrets/forkline.env
```

If you have no computer to generate the token on, try the bundled binary, and follow what it prints:

```bash
node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude setup-token
```

To see the API key your client needs:

```bash
grep FORKLINE_API_KEY secrets/forkline.env
```

## 6. Start Forkline

```bash
npm start
```

It prints a `listening` line on port 8800. Leave it running. It uses `config/forkline.dev.json`, which only listens on the phone itself.

Check it from a second Termux session. Swipe from the left edge of the screen, tap **New session**, and run this with your key:

```bash
curl http://127.0.0.1:8800/health -H "Authorization: Bearer <your key>"
```

Expect `{"status":"ok", ...}`.

## 7. Connect your client

In your client's OpenAI-compatible provider settings:

- **URL:** `http://127.0.0.1:8800/v1`
- **Key:** your `FORKLINE_API_KEY`
- **Model:** pick from the list. Haiku 5.5 uses the least of your limits

## 8. Stop Android killing it

Android stops background processes to save memory and battery. This is the most likely problem you'll hit.

1. **Wake lock.** In a Termux session outside Ubuntu, run `termux-wake-lock`. Termux's notification then shows that the lock is on. Run `termux-wake-unlock` to release it.
2. **Battery.** In Android settings, set Termux's battery usage to **Unrestricted**.
3. **Phantom process limit.** Android 12 and later can kill Termux's child processes.
   - On Android 14 and later: turn on **Disable child process restrictions** in Developer options.
   - On Android 12 and 13: run this from a computer with `adb`:

     ```bash
     adb shell "/system/bin/device_config put activity_manager max_phantom_processes 2147483647"
     ```

Some phone makers add their own limits, which these settings may not cover.

## Everyday use

Start it:

```bash
termux-wake-lock
proot-distro login ubuntu
cd ~/forkline && npm start
```

Stop it with `Ctrl+C`, then type `exit` and run `termux-wake-unlock`. The wake lock uses battery, so release it when you're done.

Update it:

```bash
cd ~/forkline && git pull && npm ci --no-audit --no-fund && npm run build
```

## What to check

Forkline's log prints a `request` line for each message, with no chat text in it. Try these and note what happens:

| Check | How | Good result |
|---|---|---|
| It replies | Send a message in a chat with a greeting | `"status":200` |
| Speed | Read `firstByteMs` and `durationMs` | About 3 to 6 seconds to the first text on a laptop for a short chat. Expect slower here |
| Caching | Swipe the same message | `cacheRead` covers most of the prompt, and `cacheWrite` is near 0 |
| Environment text is gone | Ask out of character: "What is today's date and your working folder? Say unknown if you can't see them." | It doesn't know them |
| Adjustment | Read `adjustments` in the log | Includes `environment-block-replaced` |
| Stopping | Stop a reply partway | The next message works |
| Staying alive | Lock the phone for 10 minutes, then send a message | It replies |
| No files left | After a few chats, run `find /tmp ~/.forkline-dev -name '*.jsonl'` in Ubuntu with nothing running | Nothing listed |

If the model knows the date or folder, the replacement didn't match on this setup. Chats still work, with about 360 more tokens per request.

## Limitations

- **Slower replies.** `proot` intercepts system calls, and Forkline starts a new Claude Code process for each reply.
- **Battery and heat.** Your phone does all the work, and the wake lock keeps it awake.
- **Only reachable from the phone.** It listens on `127.0.0.1`, which suits a client on the same phone. Don't change that to expose it on a network.
- **Keep it private.** Any app on your phone can reach the port, but it still needs your key.
- **A phone is not a server.** If Android kills it, replies stop until you restart it. A VPS is more reliable: see [RUNBOOK.md](RUNBOOK.md).
