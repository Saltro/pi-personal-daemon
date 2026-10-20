import { loadConfig } from './config.js';
import {
  deleteCron,
  getCron,
  loadCronRegistry,
  makeRuntimeCron,
  putCron,
  type RuntimeCronRecord,
  type RuntimeCronTarget,
} from './cron-registry.js';

interface ParsedOptions {
  positionals: string[];
  id?: string;
  prompt?: string;
  stdin?: boolean;
  cron?: string;
  at?: string;
  target?: RuntimeCronTarget;
  enabled?: boolean;
}

function usage(): never {
  console.error(`Usage:
  pi-personal cron create --id <id> --prompt <text>|--stdin (--cron <expr> | --at <time>) [--target main|new|session:<id>] [--enabled|--disabled]
  pi-personal cron list
  pi-personal cron status <id>
  pi-personal cron update <id> [--prompt <text>|--stdin] [--cron <expr>|--at <time>] [--target main|new|session:<id>] [--enabled|--disabled]
  pi-personal cron disable <id>
  pi-personal cron delete <id>`);
  process.exit(2);
}

function parseOptions(args: string[]): ParsedOptions {
  const out: ParsedOptions = { positionals: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--stdin') out.stdin = true;
    else if (arg === '--enabled') out.enabled = true;
    else if (arg === '--disabled') out.enabled = false;
    else if (arg === '--id') out.id = needValue(args, ++i, arg);
    else if (arg === '--prompt') out.prompt = needValue(args, ++i, arg);
    else if (arg === '--cron') out.cron = needValue(args, ++i, arg);
    else if (arg === '--at') out.at = needValue(args, ++i, arg);
    else if (arg === '--target') out.target = parseTarget(needValue(args, ++i, arg));
    else if (arg.startsWith('--')) usage();
    else out.positionals.push(arg);
  }
  return out;
}

function parseTarget(value: string): RuntimeCronTarget {
  if (value === 'main' || value === 'new' || value.startsWith('session:')) return value as RuntimeCronTarget;
  throw new Error(`invalid --target: ${value}`);
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

async function promptFromOptions(opts: ParsedOptions): Promise<string | undefined> {
  let text = opts.prompt;
  if (opts.stdin) text = await readStdin();
  text = text?.trim();
  return text || undefined;
}

function scheduleFromOptions(opts: ParsedOptions): RuntimeCronRecord['schedule'] | undefined {
  if (opts.cron && opts.at) throw new Error('use either --cron or --at');
  if (opts.cron) return { type: 'cron', expression: opts.cron };
  if (opts.at) return { type: 'at', at: opts.at };
  return undefined;
}

export async function runCronCli(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  const config = loadConfig();
  const opts = parseOptions(rest);
  if (command === 'create') {
    if (!opts.id) throw new Error('cron create requires --id');
    const prompt = await promptFromOptions(opts);
    if (!prompt) throw new Error('cron create requires --prompt or --stdin');
    const schedule = scheduleFromOptions(opts);
    if (!schedule) throw new Error('cron create requires --cron or --at');
    if (loadCronRegistry(config).crons[opts.id]) throw new Error(`cron already exists: ${opts.id}`);
    console.log(JSON.stringify(putCron(config, makeRuntimeCron({ id: opts.id, prompt, schedule, target: opts.target, enabled: opts.enabled })), null, 2));
  } else if (command === 'list') {
    const records = Object.values(loadCronRegistry(config).crons).sort((a, b) => a.id.localeCompare(b.id));
    for (const record of records) console.log(`${record.id}\t${record.status}\t${record.enabled}\t${record.target}\t${record.nextRunAt || ''}`);
  } else if (command === 'status') {
    const id = opts.positionals[0];
    if (!id) usage();
    console.log(JSON.stringify(getCron(config, id), null, 2));
  } else if (command === 'update') {
    const id = opts.positionals[0];
    if (!id) usage();
    const record = getCron(config, id);
    const prompt = await promptFromOptions(opts);
    const schedule = scheduleFromOptions(opts);
    if (prompt) record.prompt = prompt;
    if (schedule) record.schedule = schedule;
    if (opts.target) record.target = opts.target;
    if (opts.enabled !== undefined) {
      record.enabled = opts.enabled;
      record.status = opts.enabled ? 'scheduled' : 'disabled';
      if (opts.enabled) record.lastFiredAt = undefined;
    }
    console.log(JSON.stringify(putCron(config, record), null, 2));
  } else if (command === 'disable') {
    const id = opts.positionals[0];
    if (!id) usage();
    const record = getCron(config, id);
    record.enabled = false;
    record.status = record.status === 'completed' ? 'completed' : 'disabled';
    console.log(JSON.stringify(putCron(config, record), null, 2));
  } else if (command === 'delete') {
    const id = opts.positionals[0];
    if (!id) usage();
    deleteCron(config, id);
  } else usage();
}
