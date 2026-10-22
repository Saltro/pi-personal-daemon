import fs from 'node:fs';
import { loadConfig } from '../config.js';
import { detectParentCallback } from '../core/sessions/callbacks.js';
import { runSessionPrompt, selectSessionAgent } from '../core/sessions/service.js';
export { runSessionPrompt } from '../core/sessions/service.js';
import {
  getSession,
  loadRegistry,
  makeSessionId,
  newSessionRecord,
  insertSession,
  refreshSessionStatus,
} from '../core/sessions/registry.js';
import type { AppConfig } from '../types.js';

interface ParsedOptions {
  positionals: string[];
  id?: string;
  cwd?: string;
  name?: string;
  agent?: string;
  autoReturn?: boolean;
  prompt?: string;
  message?: string;
  stdin?: boolean;
  wait?: boolean;
  lines?: number;
}

function usage(): never {
  console.error(`Usage:
  retriever sessions create [--id <id>] [--cwd <cwd>] [--name <name>] [--agent <profile>] [--return|--no-return] [--prompt <text>] [--stdin] [--wait]
  retriever sessions send <id> [--message <text>] [--stdin] [--wait] [--return|--no-return]
  retriever sessions list
  retriever sessions status <id>
  retriever sessions history <id> [--lines <n>]`);
  process.exit(2);
}

function parseOptions(args: string[]): ParsedOptions {
  const out: ParsedOptions = { positionals: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--stdin') out.stdin = true;
    else if (arg === '--wait') out.wait = true;
    else if (arg === '--return') out.autoReturn = true;
    else if (arg === '--no-return') out.autoReturn = false;
    else if (arg === '--id') out.id = needValue(args, ++i, arg);
    else if (arg === '--cwd') out.cwd = needValue(args, ++i, arg);
    else if (arg === '--name') out.name = needValue(args, ++i, arg);
    else if (arg === '--agent') out.agent = needValue(args, ++i, arg);
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

export async function runSessionsCli(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  const config = loadConfig();
  if (command === 'create') await createSession(config, parseOptions(rest));
  else if (command === 'send') await sendSession(config, parseOptions(rest));
  else if (command === 'list') {
    if (rest.length) usage();
    listSessions(config);
  }
  else if (command === 'status') statusSession(config, parseOptions(rest));
  else if (command === 'history') historySession(config, parseOptions(rest));
  else usage();
}

async function createSession(config: AppConfig, opts: ParsedOptions): Promise<void> {
  const id = opts.id || makeSessionId();
  const parentCallback = detectParentCallback(config);
  const autoReturn = opts.autoReturn ?? Boolean(parentCallback);
  const prompt = await promptFromOptions(opts, 'prompt');
  let record = newSessionRecord(config, {
    id,
    cwd: opts.cwd,
    name: opts.name,
    autoReturn,
    parentCallback,
    prompt,
  });
  record = selectSessionAgent(config, record, opts.agent, opts.cwd);
  record = insertSession(config, record);
  if (prompt) record = await runSessionPrompt(config, record, prompt, Boolean(opts.wait));
  console.log(JSON.stringify(record, null, 2));
}

async function sendSession(config: AppConfig, opts: ParsedOptions): Promise<void> {
  const id = opts.positionals[0];
  if (!id) usage();
  if (opts.agent) throw new Error('--agent is only supported by sessions create; a session backend cannot be changed');
  const prompt = await promptFromOptions(opts, 'message');
  if (!prompt) throw new Error('sessions send requires --message or --stdin');
  let record = getSession(config, id);
  if (opts.autoReturn !== undefined) record.autoReturn = opts.autoReturn;
  record.parentCallback = detectParentCallback(config) ?? record.parentCallback;
  record = await runSessionPrompt(config, record, prompt, Boolean(opts.wait));
  console.log(JSON.stringify(record, null, 2));
}

function listSessions(config: AppConfig): void {
  const sessions = Object.values(loadRegistry(config).sessions).map(record => refreshSessionStatus(config, record)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const record of sessions) {
    console.log(`${record.id}\t${record.status}\t${record.autoReturn}\t${record.updatedAt}\t${record.name || ''}`);
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
