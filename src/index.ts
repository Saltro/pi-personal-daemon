#!/usr/bin/env node
import './extensions/index.js';
import { runBindCli } from './cli/bind.js';
import { runCronCli } from './cli/cron.js';
import { runDaemonCli } from './cli/daemon.js';
import { runReturnCli } from './cli/return.js';
import { runSendCli } from './cli/send.js';
import { runSessionsCli } from './cli/sessions.js';
import { runUpdateCli, runVersionCli } from './cli/update.js';
import { loadConfig } from './config.js';
import { PersonalDaemon } from './core/daemon/daemon.js';
import { daemonStatus, removeDaemonPid, writeDaemonPid } from './core/daemon/lifecycle.js';

function usage(exitCode: number): never {
  console.error(`Usage:
  retriever
  retriever daemon <start|stop|restart|status>
  retriever send <text...> | --stdin
  retriever return <text...> | --stdin
  retriever bind <destination|feishu-chat|status> ...
  retriever sessions <create|send|list|status|history> ...
  retriever cron <create|list|status|update|disable|delete> ...
  retriever update [--latest]
  retriever version`);
  process.exit(exitCode);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' || command === '-h') usage(0);
  if (command === 'version' || command === '-v' || command === '--version') runVersionCli();
  else if (command === 'update') await runUpdateCli(args);
  else if (command === 'send') await runSendCli(args);
  else if (command === 'return') await runReturnCli(args);
  else if (command === 'bind') await runBindCli(args);
  else if (command === 'sessions') await runSessionsCli(args);
  else if (command === 'cron') await runCronCli(args);
  else if (command === 'daemon') await runDaemonCli(args);
  else if (command === undefined) runForegroundDaemon();
  else usage(2);
}

/** Foreground daemon: no pid file is required, but status/stop work while it runs. */
function runForegroundDaemon(): void {
  const config = loadConfig();
  const existing = daemonStatus(config);
  if (existing.running) throw new Error(`daemon already running pid ${existing.pid}`);
  writeDaemonPid(config);
  const daemon = new PersonalDaemon(config);
  daemon.start();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.error(`[daemon] ${signal}; shutting down`);
      daemon.stop();
      removeDaemonPid(config);
      process.exit(0);
    });
  }
}

main().catch((error) => {
  console.error(`[retriever] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
