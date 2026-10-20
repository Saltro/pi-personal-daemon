#!/usr/bin/env node
import { runBindCli } from './bind-cli.js';
import { runCronCli } from './cron-cli.js';
import { runSendCli } from './send-command.js';
import { runSessionsCli } from './sessions-cli.js';

function usage(): never {
  console.error(`Usage:
  pi-personal send <text...> | --stdin
  pi-personal bind <feishu-chat|status> ...
  pi-personal sessions <create|send|list|status|history> ...
  pi-personal cron <create|list|status|update|disable|delete> ...`);
  process.exit(2);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'send') await runSendCli(args, 'pi-personal send');
  else if (command === 'bind') await runBindCli(args);
  else if (command === 'sessions') await runSessionsCli(args);
  else if (command === 'cron') await runCronCli(args);
  else usage();
}

main().catch(error => {
  console.error(`[pi-personal] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
