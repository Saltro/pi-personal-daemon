import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { normalizeRuntimeCron } from './cron-registry.js';
import { legacyContextPath, stateDbPath, stateDir } from './state-paths.js';
import type { AppConfig } from './types.js';
import type { RuntimeCronRecord } from './cron-registry.js';

const SCHEMA_VERSION = 3;
const connections = new Map<string, DatabaseSync>();
type FieldKind = 'text' | 'number' | 'boolean' | 'json';
export type StateFields = Record<string, FieldKind>;
const recordSnapshots = new WeakMap<object, Record<string, unknown>>();

export function trackStateRecord<T extends object>(record: T): T {
  recordSnapshots.set(record, structuredClone(record) as Record<string, unknown>);
  return record;
}

export function changedStateFields(record: object): Record<string, unknown> {
  const previous = recordSnapshots.get(record);
  const current = record as Record<string, unknown>;
  if (!previous) return { ...current };
  const patch: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(current[key])) patch[key] = current[key];
  }
  return patch;
}
export const sessionFields: StateFields = {
  id: 'text', sessionId: 'text', cwd: 'text', sessionDir: 'text', name: 'text', status: 'text',
  pid: 'number', watcherPid: 'number', runId: 'text', agentProfile: 'text', agentProfileSnapshot: 'json', autoReturn: 'boolean',
  parentCallback: 'json', parentNotificationPath: 'text', createdAt: 'text', updatedAt: 'text',
  lastPrompt: 'text', lastResult: 'text', logPath: 'text', exitCode: 'number', error: 'text',
};
export const cronFields: StateFields = {
  id: 'text', prompt: 'text', scheduleType: 'text', scheduleValue: 'text', target: 'text',
  enabled: 'boolean', status: 'text', createdAt: 'text', updatedAt: 'text',
  lastFiredAt: 'text', nextRunAt: 'text', lastError: 'text', runId: 'text',
};
export const contextFields: StateFields = {
  chatId: 'text', eventId: 'text', messageId: 'text', source: 'text', kind: 'text', textChars: 'number',
  startedAt: 'text', sendCount: 'number', lastSentAt: 'text', contextUsage: 'text', contextUsageSource: 'text',
};

export function getStateDb(config: AppConfig): DatabaseSync {
  const file = path.resolve(stateDbPath(config));
  const existing = connections.get(file);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    stateTransaction(db, () => {
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
      if (version > SCHEMA_VERSION) throw new Error(`unsupported state schema version ${version}; maximum supported is ${SCHEMA_VERSION}`);
      if (version === 0) {
        db.exec(`
          CREATE TABLE state_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE sessions (
            id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, cwd TEXT NOT NULL, sessionDir TEXT, name TEXT,
            status TEXT NOT NULL CHECK(status IN ('idle','running','completed','failed')),
            pid INTEGER, watcherPid INTEGER, runId TEXT, agentProfile TEXT, agentProfileSnapshot TEXT,
            notify INTEGER NOT NULL CHECK(notify IN (0,1)), parentCallback TEXT, parentNotificationPath TEXT,
            createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, lastPrompt TEXT, lastResult TEXT,
            logPath TEXT NOT NULL, exitCode INTEGER, error TEXT
          );
          CREATE TABLE crons (
            id TEXT PRIMARY KEY, prompt TEXT NOT NULL, scheduleType TEXT NOT NULL CHECK(scheduleType IN ('cron','at')),
            scheduleValue TEXT NOT NULL, target TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
            status TEXT NOT NULL CHECK(status IN ('scheduled','running','completed','disabled','failed')),
            createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, lastFiredAt TEXT, nextRunAt TEXT, lastError TEXT
          );
          CREATE INDEX crons_due ON crons(enabled, status, nextRunAt);
          CREATE TABLE current_context (
            singleton INTEGER PRIMARY KEY CHECK(singleton = 1), chatId TEXT NOT NULL, eventId TEXT NOT NULL,
            messageId TEXT, source TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('message','wake')),
            textChars INTEGER NOT NULL CHECK(textChars >= 0), startedAt TEXT NOT NULL,
            sendCount INTEGER NOT NULL CHECK(sendCount >= 0), lastSentAt TEXT, contextUsage TEXT, contextUsageSource TEXT
          );
          CREATE TABLE visible_binding (
            singleton INTEGER PRIMARY KEY CHECK(singleton = 1), chatId TEXT NOT NULL,
            createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, source TEXT
          );
          CREATE TABLE parent_notifications (
            id TEXT PRIMARY KEY, createdAt TEXT NOT NULL, payload TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','delivered','failed')),
            attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0), availableAt TEXT NOT NULL,
            claimedAt TEXT, deliveredAt TEXT, lastError TEXT
          );
          CREATE INDEX notifications_pending ON parent_notifications(status, availableAt, createdAt, id);
          PRAGMA user_version = 1;
        `);
      }
      if (version < 2) {
        db.exec('ALTER TABLE crons ADD COLUMN runId TEXT; PRAGMA user_version = 2;');
      }
      if (version < 3) {
        db.exec('ALTER TABLE sessions RENAME COLUMN notify TO autoReturn; PRAGMA user_version = 3;');
      }
      if (!db.prepare('SELECT value FROM state_meta WHERE key = ?').get('legacy-json-v1')) {
        importLegacyState(db, config);
        db.prepare('INSERT INTO state_meta(key, value) VALUES (?, ?)').run('legacy-json-v1', new Date().toISOString());
      }
    });
  } catch (error) {
    db.close();
    throw new Error(`Cannot initialize daemon state database ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  connections.set(file, db);
  return db;
}

export function closeStateDb(config: AppConfig): void {
  const file = path.resolve(stateDbPath(config));
  const db = connections.get(file);
  if (db) { db.close(); connections.delete(file); }
}

export function stateTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('state transactions must be synchronous');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function decodeStateRow<T>(row: Record<string, unknown>, fields: StateFields): T {
  const record: Record<string, unknown> = {};
  for (const [key, kind] of Object.entries(fields)) {
    const value = row[key];
    // Only an explicit null exit code has meaning in the public record API.
    record[key] = value == null ? (key === 'exitCode' ? null : undefined)
      : kind === 'json' ? JSON.parse(String(value)) : kind === 'boolean' ? Boolean(value) : value;
  }
  return record as T;
}

function encodeStateValue(value: unknown, kind: FieldKind): SQLInputValue {
  if (value === undefined || value === null) return null;
  if (kind === 'json') return JSON.stringify(value);
  if (kind === 'boolean') return value ? 1 : 0;
  return value as SQLInputValue;
}

export function insertStateRow(db: DatabaseSync, table: string, fields: StateFields, record: object, ignoreExisting = false): void {
  const keys = Object.keys(fields);
  const values = record as Record<string, unknown>;
  db.prepare(`INSERT ${ignoreExisting ? 'OR IGNORE ' : ''}INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map(key => encodeStateValue(values[key], fields[key])));
}

export function patchStateRow(db: DatabaseSync, table: string, fields: StateFields, id: string, patch: object): void {
  const values = patch as Record<string, unknown>;
  const keys = Object.keys(values).filter(key => key !== 'id' && Object.hasOwn(fields, key));
  if (!keys.length) return;
  db.prepare(`UPDATE ${table} SET ${keys.map(key => `${key} = ?`).join(',')} WHERE id = ?`)
    .run(...keys.map(key => encodeStateValue(values[key], fields[key])), id);
}

export function cronToRow(record: RuntimeCronRecord): object {
  const { schedule, ...rest } = record;
  return { ...rest, scheduleType: schedule.type, scheduleValue: schedule.type === 'cron' ? schedule.expression : schedule.at };
}

export function cronFromRow(row: Record<string, unknown>): RuntimeCronRecord {
  const { scheduleType, scheduleValue, ...record } = decodeStateRow<Record<string, unknown>>(row, cronFields);
  return { ...record, schedule: scheduleType === 'cron' ? { type: 'cron', expression: scheduleValue } : { type: 'at', at: scheduleValue } } as RuntimeCronRecord;
}

function legacyJson(file: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(file)) return undefined;
  try { return requireObject(JSON.parse(fs.readFileSync(file, 'utf8')), 'root'); }
  catch (error) { throw new Error(`Legacy state import failed for ${file}: ${error instanceof Error ? error.message : String(error)}. Original files were retained; fix the source and retry.`, { cause: error }); }
}

function importLegacyState(db: DatabaseSync, config: AppConfig): void {
  const root = stateDir(config);
  const importFile = (file: string, importValue: (value: Record<string, unknown>) => void) => {
    const value = legacyJson(file);
    if (!value) return;
    try { importValue(value); }
    catch (error) { throw new Error(`Legacy state import failed for ${file}: ${error instanceof Error ? error.message : String(error)}. Original files were retained; fix the source and retry.`, { cause: error }); }
  };
  importFile(path.join(root, 'sessions', 'registry.json'), raw => {
    const sessions = requireObject(raw.sessions, 'sessions');
    for (const [id, value] of Object.entries(sessions)) {
      const record = requireObject(value, `session ${id}`);
      requireStrings(record, ['id', 'sessionId', 'cwd', 'logPath', 'createdAt', 'updatedAt']);
      if (record.id !== id) throw new Error(`session key ${id} differs from record id ${String(record.id)}`);
      requireChoice(record.status, ['idle', 'running', 'completed', 'failed'], `session ${id} status`);
      optionalStrings(record, ['sessionDir', 'name', 'runId', 'agentProfile', 'parentNotificationPath', 'lastPrompt', 'lastResult', 'error']);
      requireDates(record, ['createdAt', 'updatedAt']);
      optionalInteger(record.pid, 'pid', 1);
      optionalInteger(record.watcherPid, 'watcherPid', 1);
      optionalInteger(record.exitCode, 'exitCode');
      if (record.parentCallback !== undefined) validateParent(requireObject(record.parentCallback, 'parentCallback'));
      if (record.agentProfileSnapshot !== undefined) requireObject(record.agentProfileSnapshot, 'agentProfileSnapshot');
      // The old notify property is accepted only when importing retained JSON state.
      if (record.notify !== undefined && typeof record.notify !== 'boolean' && !['parent', 'none', 'feishu'].includes(String(record.notify))) throw new Error(`invalid legacy notify for session ${id}`);
      if (record.autoReturn !== undefined && typeof record.autoReturn !== 'boolean') throw new Error(`invalid legacy autoReturn for session ${id}`);
      const autoReturn = record.autoReturn ?? (record.notify === true || record.notify === 'parent');
      insertStateRow(db, 'sessions', sessionFields, { ...record, autoReturn });
    }
  });
  importFile(path.join(root, 'cron', 'registry.json'), raw => {
    if (raw.version !== 1) throw new Error(`unsupported legacy cron version ${String(raw.version)}`);
    for (const [id, value] of Object.entries(requireObject(raw.crons, 'crons'))) {
      const record = requireObject(value, `cron ${id}`);
      requireStrings(record, ['id', 'prompt', 'target', 'createdAt', 'updatedAt']);
      requireDates(record, ['createdAt', 'updatedAt', 'lastFiredAt', 'nextRunAt']);
      optionalStrings(record, ['lastError', 'runId']);
      if (record.id !== id) throw new Error(`cron key ${id} differs from record id ${String(record.id)}`);
      if (typeof record.enabled !== 'boolean') throw new Error(`cron ${id} enabled must be boolean`);
      requireChoice(record.status, ['scheduled', 'running', 'completed', 'disabled', 'failed'], `cron ${id} status`);
      const schedule = requireObject(record.schedule, 'schedule');
      requireChoice(schedule.type, ['cron', 'at'], 'schedule type');
      requireStrings(schedule, [schedule.type === 'cron' ? 'expression' : 'at']);
      insertStateRow(db, 'crons', cronFields, cronToRow(normalizeRuntimeCron(record as unknown as RuntimeCronRecord)));
    }
  });
  const context = legacyContextPath(config);
  if (context) importFile(context, record => {
    requireStrings(record, ['chatId', 'eventId', 'source', 'kind', 'startedAt']);
    requireDates(record, ['startedAt', 'lastSentAt']);
    optionalStrings(record, ['messageId', 'contextUsage', 'contextUsageSource']);
    requireChoice(record.kind, ['message', 'wake'], 'context kind');
    if (!Number.isInteger(record.textChars) || Number(record.textChars) < 0) throw new Error('context textChars must be a nonnegative integer');
    if (record.sendCount === undefined) record.sendCount = 0;
    if (!Number.isInteger(record.sendCount) || Number(record.sendCount) < 0) throw new Error('context sendCount must be a nonnegative integer');
    insertStateRow(db, 'current_context', { singleton: 'number', ...contextFields }, { singleton: 1, ...record });
  });
  importFile(path.join(root, 'feishu-chat-binding.json'), record => {
    requireStrings(record, ['chatId', 'createdAt', 'updatedAt']);
    requireDates(record, ['createdAt', 'updatedAt']);
    optionalStrings(record, ['source']);
    insertStateRow(db, 'visible_binding', { singleton: 'number', chatId: 'text', createdAt: 'text', updatedAt: 'text', source: 'text' }, { singleton: 1, ...record });
  });
  const callbacks = path.join(root, 'session-callbacks');
  if (!fs.existsSync(callbacks)) return;
  for (const parent of fs.readdirSync(callbacks).sort()) {
    const dir = path.join(callbacks, parent);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort()) {
      importFile(path.join(dir, name), notice => {
        validateLegacyNotice(notice);
        const existing = db.prepare('SELECT payload FROM parent_notifications WHERE id = ?').get(String(notice.id));
        const payload = JSON.stringify(notice);
        if (existing) {
          if (existing.payload !== payload) throw new Error(`duplicate callback id ${String(notice.id)} has conflicting content`);
          return;
        }
        db.prepare('INSERT INTO parent_notifications(id, createdAt, payload, availableAt) VALUES (?, ?, ?, ?)')
          .run(String(notice.id), String(notice.createdAt), payload, String(notice.createdAt));
      });
    }
  }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function requireStrings(record: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) if (typeof record[key] !== 'string' || !(record[key] as string).trim()) throw new Error(`${key} must be a nonempty string`);
}
function optionalStrings(record: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) if (record[key] !== undefined && typeof record[key] !== 'string') throw new Error(`${key} must be a string`);
}
function requireDates(record: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) if (record[key] !== undefined && (typeof record[key] !== 'string' || !Number.isFinite(Date.parse(record[key] as string)))) throw new Error(`${key} must be a valid timestamp`);
}
function optionalInteger(value: unknown, label: string, minimum = -Infinity): void {
  if (value != null && (!Number.isSafeInteger(value) || Number(value) < minimum)) throw new Error(`${label} must be an integer >= ${minimum}`);
}
function requireChoice(value: unknown, choices: string[], label: string): void {
  if (!choices.includes(String(value))) throw new Error(`invalid ${label}: ${String(value)}`);
}
function validateParent(parent: Record<string, unknown>): void {
  requireStrings(parent, ['sessionId', 'queuePath', 'createdAt']);
  requireDates(parent, ['createdAt']);
  optionalStrings(parent, ['sessionFile', 'cwd', 'sessionDir']);
}
function validateLegacyNotice(notice: Record<string, unknown>): void {
  requireStrings(notice, ['id', 'createdAt', 'type']);
  requireDates(notice, ['createdAt']);
  requireChoice(notice.type, ['session.completed', 'session.return'], 'callback type');
  validateParent(requireObject(notice.parent, 'callback parent'));
  if (notice.type === 'session.return') {
    requireStrings(notice, ['text']);
    if (notice.child !== undefined) optionalStrings(requireObject(notice.child, 'callback child'), ['id', 'sessionId']);
  } else {
    const child = requireObject(notice.child, 'callback child');
    requireStrings(child, ['id', 'sessionId', 'cwd', 'status', 'logPath', 'updatedAt']);
    requireDates(child, ['updatedAt']);
    requireChoice(child.status, ['idle', 'running', 'completed', 'failed'], 'callback child status');
    optionalStrings(child, ['sessionDir', 'lastResult', 'error']);
    optionalInteger(child.exitCode, 'callback exitCode');
  }
}
