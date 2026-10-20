# pi-personal-daemon

Minimal TypeScript prototype for a single personal Feishu → Pi carrier daemon.

## Shape

- One local daemon on one machine, bound to one Pi agent session.
- Feishu stays the client entrance.
- Pi is the runtime: memory, tools, web search, subagents, skills, and compression stay inside Pi.
- The daemon only handles transport duties: receive events, normalize prompts, run or continue Pi over RPC, expose a local send CLI, and trigger timed wakeups.
- Product concepts such as workspaces, channels, tasks, multi-bot orchestration, and a separate search layer are outside this prototype.

## Files

- `src/config.ts` — config from `config.json` plus env overrides.
- `src/events.ts` — inbound Feishu/mock event normalization and Pi prompt formatting.
- `src/receivers.ts` — HTTP webhook receiver and stdin JSON/text receiver.
- `src/pi-runner.ts` — minimal Pi RPC subprocess client.
- `src/runtime-context.ts` — current inbound context file used by the local send CLI for reply metadata.
- `src/feishu-binding.ts` — durable single Feishu chat binding under the daemon state directory.
- `src/bind-cli.ts` — `pi-personal bind` commands for the Feishu chat binding.
- `src/cli.ts` — `pi-personal` main CLI with `send`, `bind`, `sessions`, and `cron` subcommands.
- `src/send-command.ts` — shared send command implementation.
- `src/cron-cli.ts` — persistent runtime cron commands.
- `src/cron-registry.ts` — JSON-backed runtime cron registry.
- `src/runtime-cron-dispatch.ts` — daemon dispatcher for persisted runtime cron records.
- `src/sessions-cli.ts` — local session registry commands.
- `src/session-registry.ts` — JSON-backed session registry.
- `src/session-watcher.ts` — async session completion watcher.
- `src/sender.ts` — outbound sender interface, mock sender, Feishu interactive-card sender/reaction helper.
- `src/scheduler.ts` — timed wakeups with `intervalMs` or a small standard 5-field cron subset.
- `src/daemon.ts` — serial event pipeline.
- `src/index.ts` — CLI entrypoint source.
- `src/types.ts` — shared config/event/sender types.
- `test/smoke.ts` — local mock smoke test.
- `rsbuild.config.ts` — Rsbuild bundle config for Node output.
- `tsconfig.json` — TypeScript typecheck config.
- `scripts/fix-bin.js` — post-build shebang/chmod for the CLI bundle.
- `dist/index.js` — generated runnable CLI bundle after `npm run build`.

## Install

```bash
cd /data00/home/fengzhiyang.ping/pi-personal-daemon
npm install
cp config.example.json config.json
```

Edit `config.json` or use env vars:

```bash
export PI_DAEMON_SESSION_ID=personal-agent
export PI_DAEMON_CWD=/data00/home/fengzhiyang.ping
export PI_DAEMON_MOCK_OUTBOX=/tmp/pi-personal-outbox.jsonl
export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=xxx
export FEISHU_VERIFICATION_TOKEN=xxx
export FEISHU_ENCRYPT_KEY=xxx
export FEISHU_BASE_URL=https://open.feishu.cn
```

## Build

```bash
npm run typecheck
npm run build
```

`npm run build` uses Rsbuild and writes `dist/index.js`, `dist/cli.js`, and `dist/session-watcher.js`. The daemon is exposed as `pi-personal-daemon`; the local CLI is `pi-personal`.

## Run locally with mock sender

```bash
cd /data00/home/fengzhiyang.ping/pi-personal-daemon
npm run build
node dist/index.js
```

For source-mode development:

```bash
npm run dev
```

Type a text line on stdin:

```text
hello from stdin
```

Or send a mock HTTP message:

```bash
curl -sS -X POST http://127.0.0.1:8787/feishu/webhook \
  -H 'content-type: application/json' \
  -d '{"type":"message","id":"local-1","chatId":"chat-local","text":"hello"}'
```

The daemon writes current inbound context to the runtime context file, prompts Pi, and leaves visible replies to the agent. Real Feishu inbound messages auto-create the single chat binding when none exists. For mock/local use, bind a destination first:

```bash
pi-personal bind feishu-chat --chat-id chat-local
pi-personal bind status
printf 'reply text' | pi-personal send --stdin
```

Replies are appended as JSONL to `outbox.jsonl` when `sender.type` is `mock`.

## Smoke test

```bash
npm run smoke
```

The smoke test runs `test/smoke.ts` with `tsx` and uses `agent.mock=true`, so it validates the daemon pipeline without starting a real Pi model call. It covers `pi-personal send` and the local `pi-personal sessions` MVP.

## Pi RPC behavior

`src/pi-runner.ts` starts:

```bash
pi --mode rpc --session-id <sessionId> ...extraArgs
```

`agent.sessionDir` is optional. When explicitly configured, the runner adds `--session-dir <sessionDir>`; otherwise Pi uses its normal/default session storage, so `pi --resume` can find the session normally.

For each inbound event, the daemon writes the current context file, sends a processing reaction when a Feishu `message_id` is available, sends a `prompt` command, and waits for `agent_settled`. The prompt tells the agent to call `pi-personal send --stdin` for visible Feishu replies. The daemon logs `reply not sent` when the agent settles without using the send CLI.

## `pi-personal` CLI

Bind the single Feishu chat destination:

```bash
pi-personal bind feishu-chat --chat-id oc_xxx
pi-personal bind status
```

Visible replies always send to the bound Feishu chat. The current inbound context supplies metadata such as `inReplyTo`, `sendCount`, and the daemon-populated context usage footer:

```bash
pi-personal send '**hello** from markdown'
printf 'hello from `stdin`' | pi-personal send --stdin
```

The text or stdin body is placed in a Feishu card JSON 2.0 `markdown` element so inline code, lists, and other card markdown features render in the client. The card uses the v2 envelope (`schema: "2.0"`, `config.update_multi`, `config.width_mode`, and vertical `body.elements`), matching Feishu's inline-code support and botmux's reply-card shape. The send command appends a small grey footer from the runtime context file with only context occupancy, such as `Context 37%`; agents keep the message body focused on reply content.

Session-control MVP:

```bash
pi-personal sessions create --id research-1 --name "Research" --prompt "look into X" --wait
pi-personal sessions send research-1 --message "continue with Y" --wait
pi-personal sessions create --prompt "run async" --return
pi-personal sessions create --prompt "run async silently" --no-return
pi-personal sessions list
pi-personal sessions status research-1
pi-personal sessions history research-1 --lines 80
```

The registry is a local JSON file under `runtime.stateDir` or `~/.cache/pi-personal-daemon/sessions/registry.json`. Each record stores `id`, `sessionId`, `cwd`, optional `sessionDir`, `status`, watcher `pid`, boolean `notify`, parent callback metadata, timestamps, last prompt/result, log path, and last parent notification path.

`--return` has one meaning: notify the parent/main Pi session when the child session completes. `--notify` remains a compatibility alias, and `--no-notify` remains a compatibility alias for `--no-return`. It writes a local callback queue entry under `runtime.stateDir/session-callbacks/<parent-session-id>/`. The daemon polls that queue and turns the completion into an internal wake message for the main Pi session, so the parent can decide whether to send Feishu with `pi-personal send`, inspect `pi-personal sessions history <id>`, continue the child, or record the result.

When `--return` is omitted, `sessions create` defaults to parent notification if `PI_SESSION_ID` or `PI_SESSION_FILE` is available in the current Pi process. Outside Pi, it defaults to `--no-return`. Parent notification is local-file based; the daemon for the same `runtime.stateDir` must be running to deliver the queue entry into the main session.

The runner also exposes `getState()` and `getMessages()` through Pi RPC commands. Before and after each Pi prompt, the daemon calls `get_state` and `get_messages`, extracts context occupancy only from semantically named context/token fields, and stores it in the runtime context file for `pi-personal send`. Current Pi RPC `get_state` in this environment exposes `model.contextWindow`, `model.maxTokens`, model/session/status fields, `messageCount`, and `pendingMessageCount`; `get_messages` exposes assistant `usage` records. The footer never labels message counts, pending counts, or `model.maxTokens` as used tokens. If reliable used+limit data cannot be derived, the footer is `Context usage unavailable`.

## Scheduler / active wakeups

`config.scheduler.wakeups` accepts interval records:

```json
{
  "id": "hourly-interval",
  "intervalMs": 3600000,
  "prompt": "Active wakeup: inspect context and decide whether to send."
}
```

It also accepts standard 5-field cron records:

```json
{
  "id": "hourly-note",
  "cron": "0 * * * *",
  "prompt": "Hourly wakeup: inspect context and decide whether to send."
}
```

```json
{
  "id": "morning-check",
  "cron": "30 9 * * *",
  "prompt": "Morning wakeup: review memory and decide whether a short Feishu note would be useful."
}
```

Supported cron syntax is exactly five fields: `minute hour day-of-month month day-of-week`. Each field supports `*`, `*/n`, single numbers, and comma lists such as `0,30` or `9,17`. Ranges, names, seconds, and macros are outside this subset. Day-of-week accepts `0` or `7` for Sunday. When both day-of-month and day-of-week are specific, either field may match, following common cron behavior.

Wakeups are normalized as internal `wake` events and go through the same Pi RPC and agent-callable send path as Feishu messages. The active Pi session receives the configured prompt with the same instruction to call `pi-personal send --stdin` for visible Feishu replies; `pi-personal send` uses the bound Feishu chat.

Agents can create and edit persisted runtime schedules with `pi-personal cron`. These schedules are stored under `runtime.stateDir/cron/registry.json`, survive daemon restarts, and are polled by the daemon:

```bash
pi-personal cron create --id hourly-note --cron "0 * * * *" --prompt "Hourly wakeup: inspect context and decide whether to send." --target main
pi-personal cron create --id morning-check --cron "30 9 * * *" --prompt "Morning wakeup" --target main
pi-personal cron create --id one-shot --at "2026-10-21T09:30:00+08:00" --prompt "One-shot wakeup" --target new
pi-personal cron create --id shadow-self --cron "0 */2 * * *" --prompt "Shadow self heartbeat" --target session:shadow-self
pi-personal cron list
pi-personal cron status hourly-note
pi-personal cron update hourly-note --prompt "Updated hourly prompt" --target session:research-1
pi-personal cron disable hourly-note
pi-personal cron delete hourly-note
```

Runtime cron targets:

- `--target main`: enqueue an internal wake event into the main daemon Pi RPC session.
- `--target new`: create a new local Pi session and send the prompt there.
- `--target session:<id>`: use one fixed child Pi session. If the personal session `<id>` exists, the daemon sends the prompt there; if it is missing, the daemon creates it with session id `<id>` and reuses it on future fires.
- `--target-session <id>`: alias for `--target session:<id>`.

Use fixed child sessions for recurring personas or work streams that should keep their own Pi history, for example `--target session:shadow-self` for a recurring shadow-self heartbeat.

One-shot schedules use `--at <timestamp>` and complete automatically after firing. Recurring schedules use `--cron <expr>` and stay scheduled after each successful fire. `--stdin` can replace `--prompt <text>` for longer prompts.

## Real Feishu wiring notes

The HTTP receiver handles Feishu URL verification (`type=url_verification`), Feishu event callback v2 message shape, plaintext verification-token checking, and encrypted callback decryption with `FEISHU_ENCRYPT_KEY`.

To use real Feishu text sending, set `sender.type` to `feishu` and configure credentials through `config.json` or env:

```json
{
  "sender": { "type": "feishu", "mockOutbox": "./outbox.jsonl" },
  "feishu": {
    "appId": "cli_xxx",
    "appSecret": "xxx",
    "verificationToken": "xxx",
    "encryptKey": "xxx",
    "baseUrl": "https://open.feishu.cn"
  }
}
```

`FeishuSender` fetches `/open-apis/auth/v3/tenant_access_token/internal`, caches the tenant token, and sends interactive cards through `/open-apis/im/v1/messages?receive_id_type=chat_id` with payload shape `{ receive_id, msg_type: "interactive", content: JSON.stringify({ schema: "2.0", config: { update_multi: true, width_mode: "fill" }, body: { direction: "vertical", elements: [{ tag: "markdown", content: markdownBody }, { tag: "hr" }, { tag: "markdown", content: greyFooter }] } }) }`. The bound Feishu chat id is stored at `runtime.stateDir/feishu-chat-binding.json` or `~/.cache/pi-personal-daemon/feishu-chat-binding.json`.

Real deployment still needs:

1. Configure Feishu app event subscription URL to `http(s)://host/feishu/webhook`.
2. Expose the local daemon through a trusted HTTPS endpoint or tunnel.
3. Grant the bot IM send/receive scopes in the Feishu app console.
4. Persist delivery state across daemon restarts.
5. Add richer handling for reply-by-message-id, attachments, images, and mentions.

## Limitations

- Real Feishu sending currently covers markdown interactive cards to chat only.
- `pi-personal send` requires a bound Feishu chat. Real Feishu inbound messages auto-bind the first chat; local/mock-only flows can use `pi-personal bind feishu-chat --chat-id <chat_id>`.
- HTTP auth is minimal and suitable for local testing only.
- Event processing is serialized in memory; pending events are lost if the process exits.
- The scheduler supports `intervalMs`, persisted one-shot runtime schedules, and a small 5-field cron subset: `*`, `*/n`, numbers, and comma lists.
- Pi RPC timeout/error handling is intentionally small.
- Attachments, images, mentions, and group-specific behavior are normalized as text only in this prototype.
