import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from './types.js';

export type SessionStatus = 'idle' | 'running' | 'completed' | 'failed';

export interface ParentCallback {
  sessionId: string;
  sessionFile?: string;
  cwd?: string;
  sessionDir?: string;
  queuePath: string;
  createdAt: string;
}

export interface PersonalSessionRecord {
  id: string;
  sessionId: string;
  cwd: string;
  sessionDir?: string;
  name?: string;
  status: SessionStatus;
  pid?: number;
  notify: boolean;
  parentCallback?: ParentCallback;
  parentNotificationPath?: string;
  createdAt: string;
  updatedAt: string;
  lastPrompt?: string;
  lastResult?: string;
  logPath: string;
  exitCode?: number | null;
  error?: string;
}

interface RegistryFile {
  sessions: Record<string, PersonalSessionRecord>;
}

type LegacySessionRecord = Omit<PersonalSessionRecord, 'notify'> & {
  notify?: boolean | string;
  callback?: unknown;
};

export function defaultStateDir(): string {
  return path.join(os.homedir(), '.cache', 'pi-personal-daemon');
}

export function stateDir(config: AppConfig): string {
  return config.runtime.stateDir || defaultStateDir();
}

export function sessionsDir(config: AppConfig): string {
  return path.join(stateDir(config), 'sessions');
}

export function registryPath(config: AppConfig): string {
  return path.join(sessionsDir(config), 'registry.json');
}

export function loadRegistry(config: AppConfig): RegistryFile {
  const file = registryPath(config);
  if (!fs.existsSync(file)) return { sessions: {} };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { sessions?: Record<string, LegacySessionRecord> };
  const sessions: Record<string, PersonalSessionRecord> = {};
  for (const [id, record] of Object.entries(raw.sessions || {})) sessions[id] = migrateRecord(record);
  return { sessions };
}

export function saveRegistry(config: AppConfig, registry: RegistryFile): void {
  const file = registryPath(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(registry, null, 2));
}

export function getSession(config: AppConfig, id: string): PersonalSessionRecord {
  const record = loadRegistry(config).sessions[id];
  if (!record) throw new Error(`session not found: ${id}`);
  return record;
}

export function putSession(config: AppConfig, record: PersonalSessionRecord): PersonalSessionRecord {
  const registry = loadRegistry(config);
  record.updatedAt = new Date().toISOString();
  registry.sessions[record.id] = record;
  saveRegistry(config, registry);
  return record;
}

export function newSessionRecord(config: AppConfig, fields: {
  id: string;
  cwd?: string;
  name?: string;
  notify: boolean;
  parentCallback?: ParentCallback;
  prompt?: string;
}): PersonalSessionRecord {
  const now = new Date().toISOString();
  const dir = sessionsDir(config);
  return {
    id: fields.id,
    sessionId: fields.id,
    cwd: fields.cwd || config.agent.cwd || process.cwd(),
    sessionDir: config.agent.sessionDir,
    name: fields.name,
    status: 'idle',
    notify: fields.notify,
    parentCallback: fields.parentCallback,
    createdAt: now,
    updatedAt: now,
    lastPrompt: fields.prompt,
    logPath: path.join(dir, `${fields.id}.log`),
  };
}

export function appendSessionLog(record: PersonalSessionRecord, text: string): void {
  fs.mkdirSync(path.dirname(record.logPath), { recursive: true });
  fs.appendFileSync(record.logPath, text);
}

export function refreshSessionStatus(config: AppConfig, record: PersonalSessionRecord): PersonalSessionRecord {
  if (record.status !== 'running' || !record.pid || processState(record.pid) === 'alive') return record;
  const pid = record.pid;
  record.status = 'completed';
  record.pid = undefined;
  if (fs.existsSync(record.logPath)) record.lastResult = fs.readFileSync(record.logPath, 'utf8').trim().slice(-4000);
  appendSessionLog(record, `
## ${new Date().toISOString()} registry repaired stale running pid=${pid}
`);
  return putSession(config, record);
}

function migrateRecord(record: LegacySessionRecord): PersonalSessionRecord {
  const { callback: _callback, ...rest } = record;
  return {
    ...rest,
    notify: record.notify === true || record.notify === 'parent',
  };
}

function processState(pid: number): 'alive' | 'zombie' | 'gone' {
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' });
  if (ps.status !== 0 || !ps.stdout.trim()) return 'gone';
  return ps.stdout.includes('Z') ? 'zombie' : 'alive';
}

export function makeSessionId(): string {
  return `ps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
