import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentProfile, AppConfig } from '../../types.js';
import { agentProcessGroupAlive } from '../runtime/process-control.js';
import {
  changedStateFields,
  decodeStateRow,
  getStateDb,
  insertStateRow,
  patchStateRow,
  sessionFields,
  stateTransaction,
  trackStateRecord,
} from '../state/db.js';
import { stateDir } from '../state/paths.js';
import { makeParentNotification, persistParentNotification } from './callbacks.js';

export { defaultStateDir, stateDir } from '../state/paths.js';
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
  watcherPid?: number;
  runId?: string;
  agentProfile?: string;
  agentProfileSnapshot?: AgentProfile;
  autoReturn: boolean;
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
const registryIds = new WeakMap<RegistryFile, Set<string>>();

export function sessionsDir(config: AppConfig): string {
  return path.join(stateDir(config), 'sessions');
}

// These paths refer to retained legacy files, not live writable state.
export function registryPath(config: AppConfig): string {
  return path.join(sessionsDir(config), 'registry.json');
}

export function loadRegistry(config: AppConfig): RegistryFile {
  const sessions: Record<string, PersonalSessionRecord> = Object.create(null);
  for (const row of getStateDb(config).prepare('SELECT * FROM sessions ORDER BY id').all()) {
    const record = trackStateRecord(decodeStateRow<PersonalSessionRecord>(row, sessionFields));
    sessions[record.id] = record;
  }
  const registry = { sessions };
  registryIds.set(registry, new Set(Object.keys(sessions)));
  return registry;
}

export function saveRegistry(config: AppConfig, registry: RegistryFile): void {
  const db = getStateDb(config);
  stateTransaction(db, () => {
    // Only explicit deletions from this loaded view are removed. Concurrently
    // inserted records are never deleted by a stale registry snapshot.
    for (const id of registryIds.get(registry) || []) {
      if (!Object.hasOwn(registry.sessions, id))
        db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    }
    for (const record of Object.values(registry.sessions)) {
      const exists = db.prepare('SELECT id FROM sessions WHERE id = ?').get(record.id);
      if (exists)
        patchStateRow(db, 'sessions', sessionFields, record.id, changedStateFields(record));
      else insertStateRow(db, 'sessions', sessionFields, record);
    }
  });
  for (const record of Object.values(registry.sessions)) trackStateRecord(record);
  registryIds.set(registry, new Set(Object.keys(registry.sessions)));
}

export function getSession(config: AppConfig, id: string): PersonalSessionRecord {
  const row = getStateDb(config).prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!row) throw new Error(`session not found: ${id}`);
  return trackStateRecord(decodeStateRow<PersonalSessionRecord>(row, sessionFields));
}

export function putSession(
  config: AppConfig,
  record: PersonalSessionRecord,
): PersonalSessionRecord {
  const db = getStateDb(config);
  const patch = changedStateFields(record);
  return stateTransaction(db, () => {
    const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(record.id);
    const updatedAt = new Date().toISOString();
    if (existing) patchStateRow(db, 'sessions', sessionFields, record.id, { ...patch, updatedAt });
    else insertStateRow(db, 'sessions', sessionFields, { ...record, updatedAt });
    return getSession(config, record.id);
  });
}

export function insertSession(
  config: AppConfig,
  record: PersonalSessionRecord,
): PersonalSessionRecord {
  const db = getStateDb(config);
  return stateTransaction(db, () => {
    if (db.prepare('SELECT id FROM sessions WHERE id = ?').get(record.id))
      throw new Error(`session already exists: ${record.id}`);
    insertStateRow(db, 'sessions', sessionFields, {
      ...record,
      updatedAt: new Date().toISOString(),
    });
    return getSession(config, record.id);
  });
}

export function claimSessionRun(
  config: AppConfig,
  record: PersonalSessionRecord,
  runId: string,
): PersonalSessionRecord {
  if (!runId.trim()) throw new Error('session runId is required');
  const db = getStateDb(config);
  const patch = changedStateFields(record);
  return stateTransaction(db, () => {
    const existing = db.prepare('SELECT * FROM sessions WHERE id = ?').get(record.id);
    if (existing?.status === 'running') throw new Error(`session busy: ${record.id}`);
    const owner = {
      ...patch,
      status: 'running',
      runId,
      pid: process.pid,
      watcherPid: undefined,
      lastResult: undefined,
      exitCode: undefined,
      error: undefined,
      parentNotificationPath: undefined,
      updatedAt: new Date().toISOString(),
    };
    if (existing) patchStateRow(db, 'sessions', sessionFields, record.id, owner);
    else insertStateRow(db, 'sessions', sessionFields, { ...record, ...owner });
    return getSession(config, record.id);
  });
}

export function updateSessionRun(
  config: AppConfig,
  id: string,
  runId: string,
  patch: Partial<PersonalSessionRecord>,
): PersonalSessionRecord | undefined {
  return stateTransaction(getStateDb(config), () =>
    updateSessionRunInTransaction(config, id, runId, patch),
  );
}

function updateSessionRunInTransaction(
  config: AppConfig,
  id: string,
  runId: string,
  patch: Partial<PersonalSessionRecord>,
): PersonalSessionRecord | undefined {
  const db = getStateDb(config);
  const row = db
    .prepare('SELECT * FROM sessions WHERE id = ? AND runId = ? AND status = ?')
    .get(id, runId, 'running');
  if (!row) return undefined;
  if (
    Object.hasOwn(patch, 'runId') &&
    patch.runId !== runId &&
    patch.status !== 'completed' &&
    patch.status !== 'failed'
  )
    throw new Error('cannot replace or clear an active session run token');
  const final = patch.status !== undefined && patch.status !== 'running';
  patchStateRow(db, 'sessions', sessionFields, id, {
    ...patch,
    ...(final ? { runId: undefined, pid: undefined, watcherPid: undefined } : {}),
    updatedAt: new Date().toISOString(),
  });
  return getSession(config, id);
}

export const finishSessionRun = updateSessionRun;

export function finishSessionRunAndReturn(
  config: AppConfig,
  id: string,
  runId: string,
  patch: Partial<PersonalSessionRecord>,
): PersonalSessionRecord | undefined {
  if (patch.status !== 'completed' && patch.status !== 'failed')
    throw new Error('finishSessionRunAndReturn requires completed or failed status');
  const db = getStateDb(config);
  return stateTransaction(db, () => {
    const record = updateSessionRunInTransaction(config, id, runId, patch);
    return record ? returnFinishedSessionInTransaction(config, record) : undefined;
  });
}

function returnFinishedSessionInTransaction(
  config: AppConfig,
  record: PersonalSessionRecord,
): PersonalSessionRecord {
  if (!record.autoReturn) return record;
  const db = getStateDb(config);
  const notice = makeParentNotification(record);
  if (notice) {
    const noticeId = persistParentNotification(config, notice);
    patchStateRow(db, 'sessions', sessionFields, record.id, { parentNotificationPath: noticeId });
  } else {
    patchStateRow(db, 'sessions', sessionFields, record.id, {
      error: [record.error, 'return failed: parent callback metadata missing']
        .filter(Boolean)
        .join('; '),
    });
  }
  return getSession(config, record.id);
}

export function newSessionRecord(
  config: AppConfig,
  fields: {
    id: string;
    cwd?: string;
    name?: string;
    autoReturn: boolean;
    parentCallback?: ParentCallback;
    prompt?: string;
    agentProfile?: string;
    agentProfileSnapshot?: AgentProfile;
  },
): PersonalSessionRecord {
  const now = new Date().toISOString();
  return {
    id: fields.id,
    sessionId: fields.id,
    cwd: fields.cwd || config.agent.cwd || process.cwd(),
    sessionDir: config.agent.sessionDir,
    name: fields.name,
    status: 'idle',
    agentProfile: fields.agentProfile,
    agentProfileSnapshot: fields.agentProfileSnapshot,
    autoReturn: fields.autoReturn,
    parentCallback: fields.parentCallback,
    createdAt: now,
    updatedAt: now,
    lastPrompt: fields.prompt,
    logPath: path.join(sessionsDir(config), `${fields.id}.log`),
  };
}

export function appendSessionLog(record: PersonalSessionRecord, text: string): void {
  fs.mkdirSync(path.dirname(record.logPath), { recursive: true });
  fs.appendFileSync(record.logPath, text);
}

export function refreshSessionStatus(
  config: AppConfig,
  record: PersonalSessionRecord,
): PersonalSessionRecord {
  // Re-read before checking the PID; a caller may hold a completed older run.
  record = getSession(config, record.id);
  if (record.status !== 'running') return record;
  if (
    (record.watcherPid && processState(record.watcherPid) === 'alive') ||
    (record.pid && processState(record.pid) === 'alive')
  )
    return record;
  // New token-owned harnesses use detached groups. A dead group leader can
  // leave live tools behind; don't free the session while they still write.
  if (record.runId && record.pid && agentProcessGroupAlive({ pid: record.pid })) return record;
  const pid = record.watcherPid || record.pid;
  const patch: Partial<PersonalSessionRecord> = {
    status: 'failed',
    pid: undefined,
    watcherPid: undefined,
    runId: undefined,
    error: `Session execution interrupted: ${pid ? `owner pid ${pid} is no longer running` : 'no owner pid was recorded'}; no successful result was recorded.`,
    exitCode: null,
  };
  if (fs.existsSync(record.logPath))
    patch.lastResult = fs.readFileSync(record.logPath, 'utf8').trim().slice(-4000);
  const db = getStateDb(config);
  const updated = stateTransaction(db, () => {
    // A watcher may have taken over between the liveness check and this short
    // transaction. Match the observed PIDs as well as the token before repairing.
    const current = db
      .prepare(
        'SELECT * FROM sessions WHERE id = ? AND status = ? AND pid IS ? AND watcherPid IS ? AND runId IS ?',
      )
      .get(
        record.id,
        'running',
        record.pid ?? null,
        record.watcherPid ?? null,
        record.runId ?? null,
      );
    if (!current) return undefined;
    patchStateRow(db, 'sessions', sessionFields, record.id, {
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    return returnFinishedSessionInTransaction(config, getSession(config, record.id));
  });
  if (updated)
    appendSessionLog(
      updated,
      `\n## ${new Date().toISOString()} registry marked interrupted stale running pid=${pid ?? 'missing'}\n`,
    );
  return updated || getSession(config, record.id);
}

function processState(pid: number): 'alive' | 'zombie' | 'gone' {
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' });
  if (ps.status !== 0 || !ps.stdout.trim()) return 'gone';
  return ps.stdout.includes('Z') ? 'zombie' : 'alive';
}

export function makeSessionId(): string {
  return `ps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
