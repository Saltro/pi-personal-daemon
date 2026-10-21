#!/usr/bin/env node
import './extensions/index.js';
import { loadConfig } from './config.js';
import { PersonalDaemon } from './core/daemon/daemon.js';
import { runBindCli } from './cli/bind.js';
import { runCronCli } from './cli/cron.js';
import { runReturnCli } from './cli/return.js';
import { runSendCli } from './cli/send.js';
import { runSessionsCli } from './cli/sessions.js';

function usage(exitCode: number): never {
  console.error(`Usage:
  pi-personal-daemon
  pi-personal-daemon send <text...> | --stdin
  pi-personal-daemon return <text...> | --stdin
  pi-personal-daemon bind <destination|feishu-chat|status> ...
  pi-personal-daemon sessions <create|send|list|status|history> ...
  pi-personal-daemon cron <create|list|status|update|disable|delete> ...`);
  process.exit(exitCode);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' || command === '-h') usage(0);
  if (command === 'send') await runSendCli(args);
  else if (command === 'return') await runReturnCli(args);
  else if (command === 'bind') await runBindCli(args);
  else if (command === 'sessions') await runSessionsCli(args);
  else if (command === 'cron') await runCronCli(args);
  else if (command === undefined) {
    const daemon = new PersonalDaemon(loadConfig());
    daemon.start();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => {
        console.error(`[daemon] ${signal}; shutting down`);
        daemon.stop();
        process.exit(0);
      });
    }
  } else usage(2);
}

main().catch(error => {
  console.error(`[pi-personal-daemon] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
