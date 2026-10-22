# retriever

A local personal daemon with one visible chat destination, a main agent, child sessions, and timed wakeups. Feishu and Pi are the default adapters; channel implementations and per-session agent backends can be selected independently.

**Single-chat and fixed visible output are product choices.** This is not a multi-chat router. All explicit child returns and requested completion notices go to the main agent. Agent-native history, tools, memory, skills, and compression stay with the selected backend.

## Install

```bash
npm install -g @saltroping/retriever
retriever --help
# retr is an alias for every subcommand:
retr daemon status
```

Retriever runs on Node **22.13+** in a Unix-like environment (macOS/Linux with `ps`). SQLite uses Node's built-in `node:sqlite`; some supported Node versions emit an experimental warning.

## Develop and test

Developing from a clone requires pnpm **10.34.4** and the same Node/Unix environment above.

```bash
pnpm install --frozen-lockfile
cp config.example.json config.json
# Edit the example paths and credentials before starting.
pnpm test
```

`pnpm test` runs typecheck, builds the Node bundles, runs focused regression tests, then the mock/fake-process smoke test. No real model or Feishu API calls are used by these tests. pnpm's default dependency-script policy remains in effect; the project does not automatically approve dependency build scripts.

```bash
pnpm run build
node dist/index.js
# With dist on PATH, the same entry runs subcommands:
export PATH="$PWD/dist:$PATH"
retriever --help
# Source-mode development:
pnpm run dev
```

### Daemon lifecycle

Running `retriever` with no arguments stays in the foreground and logs to stderr. For a detached daemon:

```bash
retriever daemon start
retriever daemon status
retriever daemon restart
retriever daemon stop
```

The pid file and background log live in `runtime.stateDir` (`daemon.pid`, `daemon.log`), so each state directory is managed independently. `start` refuses to run when a live pid already exists; `status` prints JSON and exits 1 when the daemon is not running. A pid file whose process is gone is reported as `stalePid` and removed by the next `status`, `restart`, or `stop`. Stopping sends `SIGTERM` and waits up to ten seconds for exit; it reports the log path instead of escalating to `SIGKILL`.

Bundles: `dist/index.js` (daemon and CLI) and `dist/session-watcher.js` (async supervisor). The build also writes executable `dist/retriever` and `dist/retr` helpers. Running `retriever` without arguments starts the daemon; `send`, `return`, `bind`, `sessions`, and `cron` run their subcommands and exit. Use the installed package binary or put `dist` on your PATH for manual calls; agent subprocesses receive the installed helper path automatically.

## Configuration

`RETRIEVER_CONFIG` selects a config file; otherwise the CLI loads `config.json` from its current directory. `src/config.ts` merges defaults, file configuration, and existing environment overrides. The resolved config path is passed to child processes, including when their working directory differs from the install directory.

Default adapter configuration (Feishu channel, Pi agent profile):

```json
{
  "agent": {
    "sessionId": "personal-agent",
    "cwd": "/path/to/workspace",
    "piBin": "pi",
    "extraArgs": [],
    "mock": false
  },
  "channel": { "type": "feishu" },
  "sender": { "type": "mock", "mockOutbox": "./outbox.jsonl" },
  "runtime": { "stateDir": "/path/to/daemon-state" }
}
```

Common overrides: `RETRIEVER_AGENT_SESSION_ID`, `RETRIEVER_AGENT_CWD`, `PI_BIN`, `RETRIEVER_AGENT_SESSION_DIR`, `RETRIEVER_AGENT_EXTRA_ARGS`, `RETRIEVER_AGENT_MOCK`, `RETRIEVER_CHANNEL`, `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_VERIFICATION_TOKEN`, `FEISHU_ENCRYPT_KEY`, and `FEISHU_BASE_URL`. Extra args are space-separated in the environment variable; use JSON arrays in config for arguments containing spaces.

### Channel adapters

- **`feishu`** (default): existing webhook / WebSocket receivers, interactive-card sender, reactions, and ten-second user-message debounce. `sender.type=mock` writes cards and reactions to JSONL instead of calling Feishu.
- **`stdio`**: stdin ingestion and plain-text stdout output from `retriever send`; no Feishu receiver, card, reaction, or debounce. Output belongs to the send process's stdout, so it is useful for local pipelines/debugging rather than a separate terminal notification service.

`stdin.enabled` remains an optional input source with either adapter. Feishu `eventMode` accepts `ws`, `webhook`, or both via the existing configuration. Real Feishu sending needs `sender.type=feishu` and app credentials. Webhook verification / encrypted payload handling remains in the Feishu receiver.

The static registry in `src/core/channels/registry.ts` defines the adapter boundary: receiver lifecycle, sender, binding behavior, debounce, and dedupe. Implementations live in `src/extensions/` and are registered once by `src/extensions/channels.ts`. Registration is compiled in, so every entry bundle loads the same adapters; there is no dynamic plugin loader or multi-chat routing.

### Agent profiles

The legacy `agent` config is the default profile. Add named profiles for sessions or select one for the main agent with `agent.profile`:

```json
{
  "agentProfiles": {
    "research": {
      "backend": "pi",
      "piBin": "pi",
      "cwd": "/path/to/research-workspace",
      "extraArgs": [],
      "commandTimeoutMs": 30000
    },
    "other-harness": {
      "backend": "process",
      "command": "/path/to/agent-cli",
      "args": [],
      "promptMode": "stdin",
      "timeoutMs": 600000,
      "cwd": "/path/to/workspace"
    },
    "fake": {
      "backend": "mock",
      "replyPrefix": "mock reply: "
    }
  }
}
```

Built-in backends:

- **`pi`**: main session uses persistent JSON-lines RPC; child prompts use Pi's print execution. Supports steer, native message access, and context usage. Child `--wait` awaits the supervised execution outcome; it does not change the backend protocol.
- **`process`**: runs an external harness command for each prompt, plain-text stdin by default. `promptMode=argument` expands `{prompt}` / `{sessionId}` templates, appending the prompt if no `{prompt}` template exists. This is not Pi RPC; steer/native history/context usage are explicitly unavailable. The external harness owns any persistent history and can use the session ID supplied by the adapter. Optional `timeoutMs` applies to main and child runs (positive milliseconds, at most 2,147,483,647); main defaults to ten minutes when omitted, while child runs have no execution deadline unless configured.
- **`mock`**: local deterministic results for testing.

`sessions create --agent <profile>` saves the chosen profile and resolved options. Later sends and fixed-session crons retain that selection even if global defaults change. Imported sessions without an agent selection use the legacy `agent` Pi/mock settings, not a newly selected main profile; retain those settings when switching main to another backend. There is no automatic cross-backend history migration. New sessions without `--agent` use the main/default profile.

The capability contract and selection logic are in `src/core/agents/`. Backends live in `src/extensions/` and are registered by `src/extensions/agents.ts`, which the daemon, CLI, and session supervisor each import. Add a backend there rather than teaching the core to imitate a backend's CLI protocol. A main backend without steer simply queues subsequent user-message batches instead of attempting unsupported steering.

## Fixed output and returns

Bind the single visible destination:

```bash
retriever bind destination --chat-id oc_xxx
# Compatibility alias:
retriever bind feishu-chat --chat-id oc_xxx
retriever bind status
retriever send '**hello** from markdown'
printf 'longer reply' | retriever send --stdin
```

The first real Feishu message auto-binds when no destination exists. Every visible reply uses the bound destination, not the latest callback's parent metadata. `stdio` can send without a prior binding.

The daemon does not automatically forward final agent text. Prompts tell the agent to use `retriever send` for visible output. Feishu renders card JSON 2.0 markdown and a grey context occupancy footer. Send accounting updates the current SQLite context atomically; an event switch while the network send is in flight does not increment the new event's count.

`return` is a separate path to the main agent:

```bash
retriever return 'short result for main'
printf 'longer report' | retriever return --stdin
```

It needs parent metadata supplied by a session/cron launch or the surrounding Pi process. It does not send a visible chat message.

## Sessions

```bash
retriever sessions create --id research-1 --agent research --name Research --prompt 'look into X' --wait
retriever sessions send research-1 --message 'continue with Y' --wait
retriever sessions create --agent other-harness --prompt 'run asynchronously' --no-return
retriever sessions create --prompt 'run and return the result to main' --return
retriever sessions list
retriever sessions status research-1
retriever sessions history research-1 --lines 80
```

- Each record saves the session ID, agent selection/snapshot, working directory, status, run token, worker/supervisor PID, return settings, timestamps, last prompt/result, and log path.
- A running session rejects another execution. This is cross-process acquisition, not an in-memory lock. Before a new run, an owner that has demonstrably disappeared is repaired as an interrupted failure; live workers, supervisors, or owned process groups remain busy. Old run tokens cannot complete newer runs.
- Async execution uses a unique prompt file and a supervised startup handshake. The watcher is resolved from the installed module, not the caller's cwd. Startup failures are recorded instead of being silently marked successful.
- PID loss is failure/interruption, never proof of successful completion. A still-live worker, supervisor, or owned process group prevents accidental restart overlap. Unix timeout/cancellation terminates the owned group and confirms exit before releasing the run; pipe decoding preserves UTF-8 across chunks.
- Duplicate explicit session IDs are rejected, not overwritten.
- CLI `history` shows the daemon execution log; native backend history stays with the backend.
- `--return` enables automatic return to main when a run finishes; `--no-return` disables it. The session record stores this choice as `autoReturn`. Explicit `retriever return` calls work independently of that switch. Creating or sending from a parent agent records return metadata regardless of the flag; sends without parent context retain the saved metadata. Previously affected sessions missing metadata regain it on their next send from the parent.
- Without a flag, automatic return defaults on only if `PI_SESSION_ID` or `PI_SESSION_FILE` is present. Outside Pi it defaults off.

Completion state and its requested callback are committed together in SQLite. Callback records are claimed one at a time when main actually begins delivery and acknowledged after agent processing; a waiting backlog does not consume retry attempts. A failed delivery is retried with a short backoff, up to three attempts. Interrupted claims recover on daemon startup; exhausted records remain failed for inspection. This provides bounded retry, **not exactly-once external side effects**. A crash after an agent acts but before acknowledgment can cause duplicate processing.

## SQLite state and migration

Mutable daemon state lives in `runtime.stateDir/state.sqlite`, defaulting to `~/.cache/retriever/state.sqlite`. Session/cron records are independent SQL records; current context and output binding remain singleton state. WAL, a busy timeout, short transactions, field updates, and conditional run-token writes handle multiple CLI/watcher processes.

`runtime.contextFile` only selects the legacy context import location; it does not change the state directory. Without `stateDir`, state lives in `~/.cache/retriever`, so sessions, crons, binding, and callbacks share one root. Tests and isolated clients must set an explicit temporary `stateDir`. `contextFile` is not an actively rewritten JSON projection.

First database access imports existing daemon JSON state transactionally and once:

- `sessions/registry.json`
- `cron/registry.json`
- `feishu-chat-binding.json`
- the configured legacy current context file
- existing `session-callbacks` notices

Before deploying this migration, stop the old daemon and all old state-writing CLI/watchers. Keep the same state directory and verify the new records with CLI status/list commands. Malformed legacy state fails import with an error rather than being silently discarded. Source JSON files are retained; new code does not dual-write them. Do not keep old and new writers running together. Schema version 3 renames the automatic-return field while preserving existing session settings; old JSON fields are accepted only during import, not as CLI aliases.

Logs, mock outbox, config, and Pi-native history/memory/skills remain files. Runtime SQL transactions never wait on model execution, spawn, RPC, or network calls. No real cache migration is performed by the test suite.

## Scheduler and runtime cron

Config wakeups accept an interval or standard five-field cron subset:

```json
{
  "scheduler": {
    "enabled": true,
    "wakeups": [
      { "id": "hourly", "intervalMs": 3600000, "prompt": "Inspect context and decide whether to send." },
      { "id": "morning", "cron": "30 9 * * *", "prompt": "Morning review." }
    ]
  }
}
```

Supported fields: `minute hour day-of-month month day-of-week`; `*`, `*/n`, numbers, comma lists. Sunday is `0` or `7`. Specific day-of-month and day-of-week use OR matching. Dates use the machine's local timezone. Ranges/names/seconds/macros are not supported. Long waits are split into bounded timers and the actual due time is checked before firing.

Persisted runtime schedules:

```bash
retriever cron create --id hourly --cron '0 * * * *' --prompt 'Hourly wakeup' --target main
retriever cron create --id one-shot --at '2026-11-01T09:30:00+08:00' --prompt 'One-shot task' --target new
retriever cron create --id shadow --cron '0 */2 * * *' --prompt 'Heartbeat' --target session:research-1
retriever cron list
retriever cron status hourly
retriever cron update hourly --prompt 'Updated prompt'
retriever cron disable hourly
retriever cron delete hourly
```

- `main`: enqueue a wake into main.
- `new`: create a child with the default agent profile.
- `session:<id>`: reuse the stored agent choice of that child, or create it with defaults when missing. `--target-session <id>` is an alias.
- Child/fixed cron targets run with completion returns off but keep explicit `send` / `return` metadata.
- A successful async dispatch means launch accepted, not that the child has finished. Child status records the actual execution outcome.
- One-shots complete after dispatch; recurring records calculate their next occurrence. Each claim has a run token, so a late completion cannot modify a deleted/recreated cron with the same ID.
- A persisted `running` cron found at startup becomes failed and disabled, with an interruption error. It is not silently replayed, including recurring schedules. Inspect it and explicitly update with `--enabled` to resume. Verify one-shot timing before retrying.
- A busy fixed session rejects the launch rather than creating overlapping work; inspect cron/session errors to decide the next action.

## Main RPC reliability

Pi commands have a response deadline (30 seconds by default, configurable with `commandTimeoutMs` in the Pi profile or legacy `agent` config), distinct from agent completion (10 minutes by default). Spawn/write/exit/close/timeout clean up pending commands and settled waiters. A timeout terminates the uncertain process; replacement waits for its exit rather than overlapping on the same session. Context occupancy derives only from meaningful token/context fields, not message counts or output-token limits.

## Source layout

```
src/
  index.ts                 single entry: daemon, or one CLI subcommand
  session-watcher.ts       supervised async session entry
  cli/                     send, return, bind, sessions, cron
  config.ts  types.ts      configuration schema and shared types
  core/                    backend-agnostic engine
    daemon/                event queue, debounce, reactions, callback delivery
    events.ts              inbound normalization and agent prompt framing
    channels/registry.ts   channel contract and factory registry
    agents/                backend contract, profile resolution, registration
    sessions/              records, supervised execution, returns
    cron/                  cron parsing, persisted schedules, runtime dispatch
    state/                 SQLite schema/transactions, binding, current context
    runtime/               subprocess paths/env and owned process-group control
    input/stdin.ts         optional stdin input source
  extensions/              compiled-in channel and agent implementations
    index.ts               registers both groups; used by the daemon and CLI
    agents.ts              agent-only registration for the session supervisor
    channels.ts            channel-only registration
    feishu/                channel, WebSocket/webhook receivers, sender, normalization
    stdio/                 terminal channel
    pi/                    adapter and JSON-lines RPC runner
    process/               external harness adapter
    mock/                  deterministic test adapter
test/                      storage, process lifecycle, scheduler, backend/channel, session and smoke coverage
```

`src/core/` never imports Feishu or Pi specifics; `src/extensions/` may import core contracts. The supervisor imports `src/extensions/agents.ts` only, so session runs do not load the Feishu SDK. Each entry builds into a single self-contained file, so no runtime chunk resolution is involved.

## Remaining limits

One daemon is supported per state directory; there is no multi-daemon lease system. Ordinary incoming events still queue in memory and can be lost on exit; persisted callbacks have the retry policy above. Unix harness cancellation covers the owned process group; a harness that deliberately creates a separate detached group is outside that guarantee. Feishu supports text/markdown cards and reactions, not full attachment/media workflows. Webhook authentication remains the existing local-deployment design. There is no arbitrary parent-session router, hot-loaded plugin system, or backend-history migration.
