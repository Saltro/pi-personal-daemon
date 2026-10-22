import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { mainSessionAgentProfile } from '../core/agents/registry.js';
import { daemonStatus } from '../core/daemon/lifecycle.js';
import { mainSessionRecord, selectMainSession } from '../core/sessions/main.js';
import type { PersonalSessionRecord } from '../core/sessions/registry.js';
import type { AppConfig } from '../types.js';

function usage(): never {
  console.error(`Usage:
  retriever main-session [status]
  retriever main-session use <session-id>`);
  process.exit(2);
}

export async function runMainSessionCli(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  const config = loadConfig();
  if (command === undefined || command === 'status') {
    if (rest.length) usage();
    statusMainSession(config);
  } else if (command === 'use') {
    if (rest.length !== 1) usage();
    selectMainSession(config, rest[0]);
    statusMainSession(config);
  } else usage();
}

function defaultSessionRoot(): string {
  return path.join(os.homedir(), '.pi', 'agent', 'sessions');
}

/** Pi groups sessions by working directory: --<cwd with separators replaced>-- */
function projectSessionDirectory(cwd: string): string {
  return `--${cwd.replace(/^[/\\]+/, '').replace(/[/\\:]/g, '-')}--`;
}

function findMainSessionFile(record: PersonalSessionRecord): string | undefined {
  const directory = path.join(
    record.sessionDir || defaultSessionRoot(),
    projectSessionDirectory(record.cwd),
  );
  if (!fs.existsSync(directory)) return undefined;
  const suffix = `_${record.sessionId}.jsonl`;
  const latest = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(suffix))
    .sort()
    .at(-1);
  return latest ? path.join(directory, latest) : undefined;
}

function statusMainSession(config: AppConfig): void {
  const record = mainSessionRecord(config);
  const { name, profile } = mainSessionAgentProfile(config, record);
  const sessionFile = findMainSessionFile(record);
  const daemon = daemonStatus(config);
  console.log(
    JSON.stringify(
      {
        id: record.id,
        sessionId: record.sessionId,
        name: record.name || null,
        sessionFile: sessionFile || null,
        sessionFileExists: sessionFile ? fs.existsSync(sessionFile) : false,
        agentProfile: name,
        backend: profile.backend,
        cwd: record.cwd,
        sessionDir: record.sessionDir || null,
        daemon: { running: daemon.running, pid: daemon.pid || null },
      },
      null,
      2,
    ),
  );
}
