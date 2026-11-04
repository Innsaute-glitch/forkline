# Forkline on a VPS: runbook

For one person, following the steps in order. Everything here is run by you on the VPS. Commands with `sudo` need an account that may use it.

What you get: a service called `forkline`, run by its own user `forkline`, listening on the VPS's Tailscale address only (port 8800), reached by Lumiverse with an API key. Nothing is open to the public internet.

Layout:

| Path | What it is |
|---|---|
| `/srv/forkline/app` | the built code (read-only to the service); `app.prev` is the build before it |
| `/srv/forkline/work` | Claude Code's working folder. Must stay empty and outside any git folder |
| `/srv/forkline/claude-config` | Claude Code's config folder. Forkline deletes its `projects` folder at every start; nothing else is kept there |
| `/srv/forkline/home` | the service's home folder (npm cache, nothing of yours) |
| `/etc/forkline/forkline.json` | the config (anyone may read it, only root may change it) |
| `/etc/forkline/forkline.env` | the two secrets, root only, mode 0600 |
| `/opt/node-v22.23.3-linux-<cpu>` | Node, linked at `/opt/forkline-node`; the system's own Node is not touched |

Chats are not stored. A chat is rebuilt from what Lumiverse sends on each message. While a reply is running, Claude Code keeps a temporary copy in a `claude-resume-*` folder under `/tmp`; the unit gives the service a private `/tmp` for this (`PrivateTmp=true`) so no other process can read it and it disappears when the service stops.

## 1. Before you start

- A Debian or Ubuntu VPS (x86-64 or ARM) with systemd.
- Tailscale installed and signed in on the VPS (`tailscale ip -4` prints an address starting `100.`).
- The machine that runs Lumiverse's server is on the same tailnet.
- Your Claude subscription.

## 2. Put the code on the VPS

On the VPS, as your normal user:

```
git clone <your repo address> ~/forkline
cd ~/forkline
git checkout build/forkline      # or whichever branch or tag you are deploying
```

(No git access from the VPS? On your own machine run `git archive --format=tar.gz -o forkline.tar.gz HEAD`, copy it over with `scp`, and unpack it in `~/forkline`.) The installer copies only a fixed list of folders and files (`src`, `package*.json`, the tsconfigs, `.nvmrc`, the example config), so private captures and reference code never get onto the server's app folder.

## 3. Install

```
cd ~/forkline
sudo bash deploy/install.sh
```

It finds the Tailscale address itself. If it cannot, give it one: `sudo bash deploy/install.sh --host 100.x.y.z`. (`--port 8800` changes the port.)

It does, in order: installs Node 22.23.3 (checked against nodejs.org's SHA-256 list) and `curl`/`xz` if missing, creates the `forkline` user and folders, copies the code to `app.next`, runs `npm ci` (versions exactly from the lockfile), builds, writes the config and the secrets file if they do not exist yet, installs the systemd unit, and swaps `app.next` into place. It starts the service only if the config loads. On a first install the token is still empty, so it stops there and tells you what to do next. That is expected.

## 4. The API key

The installer made a random key and put it in `/etc/forkline/forkline.env` (never printed). You will paste it into Lumiverse in step 7. To read it once:

```
sudo grep '^FORKLINE_API_KEY=' /etc/forkline/forkline.env
```

## 5. The Claude token (`setup-token`)

You need one long-lived token from your Claude subscription. Use either way.

**A. On the VPS**, with the Claude Code program that came with Forkline (not tested by us on a headless machine; if it does not work, use B):

```
cd /
sudo -u forkline env -i HOME=/srv/forkline/home PATH=/usr/bin:/bin \
  CLAUDE_CONFIG_DIR=/srv/forkline/home/setup-config \
  /srv/forkline/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude setup-token
```

(On an ARM VPS use `claude-agent-sdk-linux-arm64`.) It prints a web address. Open it in a browser on your own computer, sign in, and paste the code it gives you back into the terminal. It then prints the token (starts `sk-ant-oat`). Afterwards: `sudo rm -rf /srv/forkline/home/setup-config`.

**B. On your own computer** that already has Claude Code signed in: run `claude setup-token` and copy the token it prints.

Then put it in the secrets file. Use the editor, not the command line, so it stays out of your shell history:

```
sudoedit /etc/forkline/forkline.env
```

Set the line to `FORKLINE_CLAUDE_TOKEN=<the token>`, with no spaces and no quotes. Save. Do not paste the token anywhere else, and clear your terminal scrollback if it was printed there.

Check the file is still private: `sudo ls -l /etc/forkline/forkline.env` must show `-rw-------` and `root root`.

## 6. Start it

```
sudo systemctl start forkline
sudo systemctl status forkline --no-pager
journalctl -u forkline -n 20 -o cat
```

You should see `"msg":"listening"` with your Tailscale address. Then ask it for its health (the key stays in a shell variable, not in your history):

```
KEY=$(sudo grep '^FORKLINE_API_KEY=' /etc/forkline/forkline.env | cut -d= -f2-)
curl -s -H "Authorization: Bearer $KEY" http://100.x.y.z:8800/health
unset KEY
```

Expect `{"status":"ok", ...}`. The service starts at boot by itself. If Tailscale comes up late after a boot, the first start fails and systemd retries every 5 seconds until the address exists.

## 7. Point Lumiverse at it

- Provider type: custom OpenAI-compatible.
- Base URL: `http://100.x.y.z:8800/v1`, with the **Tailscale IP, not a MagicDNS name** (Lumiverse's Bun server cannot resolve MagicDNS names). Plain `http` is fine.
- API key: the value from step 4.
- Model: one of the ids in `/etc/forkline/forkline.json`, for example `claude-sonnet-5-5`.
- **Context budget:** Lumiverse's token counter runs about 25 to 30 percent low for current Claude models. Set its context size to about 70 percent of the model's real limit (for a 200,000-token model, about 140,000), or long chats will hit the real limit before Lumiverse thinks they are close. Output budgets are not affected.

Send a short message. A reply streaming back is the "phone test" for this task.

## 8. Checks to do on the VPS (brief section 14, "P7")

Tick each box once.

- [ ] **Token works on the VPS.** The first reply arrives. In the log, the `request` line has `"status":200`. If you see `"errorCode":"auth-failed"` (HTTP 502, "Claude Code is not signed in"), the token is wrong or expired: redo step 5 and `sudo systemctl restart forkline`.
- [ ] **The environment, model and date text is really gone on a rebuilt chat.** The VPS's folder, OS and kernel differ from your dev machine, so this must be seen here. Use a chat that already has a few messages (Lumiverse resends the history and Forkline rebuilds the session; the log line says `"routeCase":"D"` and its `adjustments` include `environment-block-replaced`). A brand-new chat's first message is not rebuilt and still carries the text, so do not test on that. Send:
  > (OOC: pause the story. Answer only from your own context, no guessing. What is today's date, what folder are you working in, what operating system are you running on, and which model are you? For anything you cannot see, write "not visible".)

  Pass: "not visible" for the date, folder and operating system. Fail: it states the real date, `/srv/forkline/work`, `Linux`, `Ubuntu` or a kernel number. A model's own name may come from your preset and does not count. On a fail, Claude Code injected its text again because one of the facts Forkline wrote (folder, OS string, cutoff) did not match what Claude Code saw on this machine. The chat still works and costs about 360 more input tokens per message; keep the log lines (no chat text in them) and report it. After a kernel update the first message of an old chat may show the text once; that is the same cause and corrects itself on the next rebuild.
- [ ] **No email reminder under `setup-token`.** Ask: "(OOC: do you see any email address or account name anywhere in your context? Answer "none" or quote it.)" Expected: none. Claude Code's billing and "You are a Claude agent" lines remain; that is known.
- [ ] **No chat text left behind.** After a few chats, with the service idle:
  ```
  sudo find / -xdev -name '*.jsonl' 2>/dev/null
  ls -A /srv/forkline/work
  ```
  Expected: no `.jsonl` file under `/srv/forkline/claude-config` or `/srv/forkline/home`, none in a `/tmp/systemd-private-*-forkline.service-*/tmp/` folder, none in `/tmp`, and nothing in the work folder. (Files from your own other tools elsewhere on the machine are not Forkline's.) During a reply, a `claude-resume-*` folder inside that private tmp is normal; it must be gone afterwards. Then look for a distinctive phrase from your chat in the logs, expecting zero:
  ```
  journalctl -u forkline -o cat | grep -c 'a phrase you wrote in the chat'
  ```
  `ls -R /srv/forkline/claude-config` should show only small settings or cache files.
- [ ] **Only the Tailscale address is open.** `ss -ltnp | grep 8800` shows your `100.x.y.z:8800`, not `0.0.0.0` or `*`. From a machine not on your tailnet, the address does not answer.
- [ ] **Survives a restart.** `sudo systemctl restart forkline`, then repeat the health call from step 6. `sudo reboot` once, then the same.
- [ ] **Lumiverse reaches it over the Tailscale IP** (step 7) and a streamed reply, including reasoning if the model thinks, shows in the app.

## 9. Everyday use

| To | Run |
|---|---|
| Watch the logs | `journalctl -u forkline -f -o cat` |
| Restart | `sudo systemctl restart forkline` |
| Stop | `sudo systemctl stop forkline` |
| Change a setting | `sudoedit /etc/forkline/forkline.json`, then restart. Do not change the `paths` entries: the unit only lets the service write to the folders in the layout above. |
| Change the key or token | `sudoedit /etc/forkline/forkline.env`, then restart |

Logs hold request metadata only (route, model, timings, token counts, adjustments, error codes), never message text, the key or the token.

**A reply stops with "the provider stopped the response because of a content_filter".** Look for:
```
journalctl -u forkline -o cat | grep 'model refused'
```
If the line says `"category":"reasoning_extraction"`, a preset or card is asking the model to put its reasoning in the reply (a `<thinking>` section, a scratchpad, a planning step, a reasoning log). Remove that instruction from the preset. There is no fallback for this category and the refused requests are billed. Other categories (`cyber`, `bio`, `frontier_llm`, `general_harms`) are reported the same way.

## 10. Upgrades

**Code or config changes.** On the VPS:
```
cd ~/forkline && git pull
sudo bash deploy/install.sh
```
It builds into `app.next`, checks that the config loads with the new build, and only then stops the old service and swaps. If the config check fails, nothing changes. If the new build does not answer `/health`, go back with `sudo bash deploy/install.sh --rollback`. Repeat the tick-boxes in step 8 for anything that touched the translator or runner.

**Changing the SDK pin** (`@anthropic-ai/claude-agent-sdk` in `package.json`, and `SDK_VERSION` in `src/constants.ts`, which must match exactly). Never do this on the VPS. On your dev machine, first run `npm run regression` against the new version; change the pin only if it passes, and commit the new lockfile. Then pull and run the installer on the VPS. The installer uses `npm ci`, so the VPS always gets the lockfile's exact versions.

**Adding a model.** Add an entry to `/etc/forkline/forkline.json` (and to `config/forkline.example.json` in the repo):
```
{ "id": "claude-...", "claudeModel": "claude-...", "marketingName": "<Claude Code's name for it>", "knowledgeCutoff": "<its cutoff, as Claude Code states it>" }
```
Use full model ids. Without exactly matching `marketingName` and `knowledgeCutoff`, Claude Code's model line stays in the request for that model. Restart the service, and run the regression check that each configured model is served as requested (check 13) before relying on it.

**Node.** Change `.nvmrc` in the repo to the new exact 22.x.y version and run the installer; it fetches that Node and relinks `/opt/forkline-node`.

## 11. Optional tightening

The unit already runs with no capabilities, a read-only system, a private `/tmp`, no new privileges and limited network families. Two settings were left out on purpose (the reasons are in the unit file): `MemoryDenyWriteExecute` (Node and the bundled Claude Code program are JIT compilers and crash with it) and `SystemCallFilter`. After everything above passes you may try the second:

```
sudo systemctl edit forkline
```
add
```
[Service]
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
```
then restart and send a chat. If replies stop working, or the log shows `status=31/SYS`, remove the drop-in: `sudo rm /etc/systemd/system/forkline.service.d/override.conf && sudo systemctl daemon-reload && sudo systemctl restart forkline`.

## 12. Problems

| Symptom | Likely cause and fix |
|---|---|
| Service restarts every few seconds, log says `cannot listen` | The Tailscale address is not up or is not the one in the config. `tailscale ip -4`, compare with `listen.host`. |
| Log says `Invalid config` | The message lists each problem. A missing key or token: `/etc/forkline/forkline.env`. |
| `217/USER` or `226/NAMESPACE` in `systemctl status` | The `forkline` user or a folder under `/srv/forkline` is missing. Run the installer again. |
| Replies fail with 502 and `auth-failed` | Token expired or wrong: step 5. |
| Replies fail with 429 | Your subscription's usage window is used up (or the model needs credits, for example `claude-fable-5`). The message says which. |
| Lumiverse cannot connect | Wrong URL (must be the Tailscale IP, `http`, port 8800, ending `/v1`), the Lumiverse machine is not on the tailnet, or the key is wrong (401). |
| Every reply fails with 502 `upstream` or the log shows the `claude` process exiting at once, but the same thing works when run by hand | A hardening line in the unit is too tight for this VPS. Try relaxing, one at a time with `sudo systemctl edit forkline` and a restart: `RestrictNamespaces=false`, `PrivateDevices=false`, `ProtectProc=default`. Tell the orchestrator which one it was. |
| Environment text shows in a rebuilt chat | See the second tick-box in step 8. |

To remove everything: `sudo systemctl disable --now forkline`, then delete `/etc/systemd/system/forkline.service`, `/etc/forkline`, `/srv/forkline`, `/opt/node-v*` and `/opt/forkline-node`, then `sudo userdel forkline`.
