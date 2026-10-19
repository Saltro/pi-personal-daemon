import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { loadConfig } from './config.js';
import { detectParentCallback } from './session-callbacks.js';
import { notifySessionCompletion } from './session-notifier.js';
import {
  appendSessionLog,
  getSession,
  loadRegistry,
  makeSessionId,
  newSessionRecord,
  putSession,
  refreshSessionStatus,
  type PersonalSessionRecord,
} from './session-registry.js';
import type { AppConfig } from './types.js';

interface ParsedOptions {
  positionals: string[];
  id?: string;
  cwd?: string;
  name?: string;
  notify?: boolean;
  prompt?: string;
  message?: string;
  stdin?: boolean;
  wait?: boolean;
  lines?: number;
}

function usage(): never {
  console.error(`Usage:
  pi-personal sessions create [--id <id>] [--cwd <cwd>] [--name <name>] [--return|--no-return] [--notify|--no-notify] [--prompt <text>] [--stdin] [--wait]
  pi-personal sessions send <id> [--message <text>] [--stdin] [--wait] [--return|--no-return] [--notify|--no-notify]
  pi-personal sessions list
  pi-personal sessions status <id>
  pi-personal sessions history <id> [--lines <n>]`);
  process.exit(2);
}

function parseOptions(args: string[]): ParsedOptions {
  const out: ParsedOptions = { positionals: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--stdin') out.stdin = true;
    else if (arg === '--wait') out.wait = true;
    else if (arg === '--notify' || arg === '--return') out.notify = true;
    else if (arg === '--no-notify' || arg === '--no-return') out.notify = false;
    else if (arg === '--id') out.id = needValue(args, ++i, arg);
    else if (arg === '--cwd') out.cwd = needValue(args, ++i, arg);
    else if (arg === '--name') out.name = needValue(args, ++i, arg);
    else if (arg === '--prompt') out.prompt = needValue(args, ++i, arg);
    else if (arg === '--message') out.message = needValue(args, ++i, arg);
    else if (arg === '--lines') out.lines = Number(needValue(args, ++i, arg));
    else if (arg.startsWith('--')) usage();
    else out.positionals.push(arg);
  }
  return out;
}

function needValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function promptFromOptions(opts: ParsedOptions, key: 'prompt' | 'message'): Promise<string | undefined> {
  let text = opts[key];
  if (opts.stdin) text = await readStdin();
  text = text?.trim();
  return text || undefined;
}

function defaultNotify(config: AppConfig): boolean {
  return Boolean(detectParentCallback(config));
}

export async function runSessionsCli(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  const config = loadConfig();
  if (command === 'create') await createSession(config, parseOptions(rest));
  else if (command === 'send') await sendSession(config, parseOptions(rest));
  else if (command === 'list') listSessions(config);
  else if (command === 'status') statusSession(config, parseOptions(rest));
  else if (command === 'history') historySession(config, parseOptions(rest));
  else usage();
}

async function createSession(config: AppConfig, opts: ParsedOptions): Promise<void> {
  const id = opts.id || makeSessionId();
  const notify = opts.notify ?? defaultNotify(config);
  const prompt = await promptFromOptions(opts, 'prompt');
  let record = newSessionRecord(config, {
    id,
    cwd: opts.cwd,
    name: opts.name,
    notify,
    parentCallback: notify ? detectParentCallback(config) : undefined,
    prompt,
  });
  putSession(config, record);
  if (prompt) record = await runPrompt(config, record, prompt, Boolean(opts.wait));
  console.log(JSON.stringify(record, null, 2));
}

async function sendSession(config: AppConfig, opts: ParsedOptions): Promise<void> {
  const id = opts.positionals[0];
  if (!id) usage();
  const prompt = await promptFromOptions(opts, 'message');
  if (!prompt) throw new Error('sessions send requires --message or --stdin');
  let record = getSession(config, id);
  if (opts.notify !== undefined) {
    record.notify = opts.notify;
    record.parentCallback = opts.notify ? detectParentCallback(config) : undefined;
  }
  record = await runPrompt(config, record, prompt, Boolean(opts.wait));
  console.log(JSON.stringify(record, null, 2));
}

function listSessions(config: AppConfig): void {
  const sessions = Object.values(loadRegistry(config).sessions).map(record => refreshSessionStatus(config, record)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const record of sessions) {
    console.log(`${record.id}\t${record.status}\t${record.notify}\t${record.updatedAt}\t${record.name || ''}`);
  }
}

function statusSession(config: AppConfig, opts: ParsedOptions): void {
  const id = opts.positionals[0];
  if (!id) usage();
  console.log(JSON.stringify(refreshSessionStatus(config, getSession(config, id)), null, 2));
}

function historySession(config: AppConfig, opts: ParsedOptions): void {
  const id = opts.positionals[0];
  if (!id) usage();
  const record = refreshSessionStatus(config, getSession(config, id));
  if (!fs.existsSync(record.logPath)) return;
  const lines = fs.readFileSync(record.logPath, 'utf8').split('\n');
  const count = opts.lines && opts.lines > 0 ? opts.lines : 40;
  console.log(lines.slice(-count).join('\n'));
}

async function runPrompt(config: AppConfig, record: PersonalSessionRecord, prompt: string, wait: boolean): Promise<PersonalSessionRecord> {
  record.status = 'running';
  record.lastPrompt = prompt;
  record.error = undefined;
  record.exitCode = undefined;
  record = putSession(config, record);
  appendSessionLog(record, `\n## ${new Date().toISOString()} prompt\n${prompt}\n\n`);

  if (config.agent.mock) {
    const result = `mock pi reply: ${prompt.slice(0, 120)}`;
    record.status = 'completed';
    record.lastResult = result;
    appendSessionLog(record, result + '\n');
    record = putSession(config, record);
    return notifyCompletion(config, record);
  }

  if (wait) return runPromptSync(config, record, prompt);
  return runPromptAsync(config, record, prompt);
}

function piArgs(config: AppConfig, record: PersonalSessionRecord, prompt: string): string[] {
  return [
    '--print',
    '--session-id', record.sessionId,
    ...(record.sessionDir ? ['--session-dir', record.sessionDir] : []),
    '--approve',
    prompt,
    ...(config.agent.extraArgs || []),
  ];
}

async function runPromptSync(config: AppConfig, record: PersonalSessionRecord, prompt: string): Promise<PersonalSessionRecord> {
  const result = spawnSync(config.agent.piBin, piArgs(config, record, prompt), {
    cwd: record.cwd,
    encoding: 'utf8',
    env: childEnv(),
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  appendSessionLog(record, output);
  record.exitCode = result.status;
  record.lastResult = output.trim().slice(-4000);
  record.status = result.status === 0 ? 'completed' : 'failed';
  if (result.error) record.error = result.error.message;
  record = putSession(config, record);
  return notifyCompletion(config, record);
}

function runPromptAsync(config: AppConfig, record: PersonalSessionRecord, prompt: string): PersonalSessionRecord {
  const promptFile = path.join(path.dirname(record.logPath), `${record.id}.prompt`);
  fs.mkdirSync(path.dirname(promptFile), { recursive: true });
  fs.writeFileSync(promptFile, prompt);
  const watcherArgs = ['dist/session-watcher.js', '--config', process.env.PERSONAL_DAEMON_CONFIG || `${process.cwd()}/config.json`, '--id', record.id, '--prompt-file', promptFile];
  const watcher = spawn(process.execPath, watcherArgs, { cwd: process.cwd(), detached: true, stdio: ['ignore', 'ignore', 'ignore'], env: childEnv() });
  record.pid = watcher.pid;
  watcher.unref();
  return putSession(config, record);
}

function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${process.cwd()}/dist:${process.env.PATH || ''}`,
  };
}

async function notifyCompletion(config: AppConfig, record: PersonalSessionRecord): Promise<PersonalSessionRecord> {
  return notifySessionCompletion(config, record);
}
