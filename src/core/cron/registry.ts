import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AppConfig } from '../../types.js';
import {
  changedStateFields,
  cronFields,
  cronFromRow,
  cronToRow,
  getStateDb,
  insertStateRow,
  patchStateRow,
  stateTransaction,
  trackStateRecord,
} from '../state/db.js';
import { stateDir } from '../state/paths.js';
import { nextCronDate } from './utils.js';

export type RuntimeCronTarget = 'main' | 'new' | `session:${string}`;
export type RuntimeCronStatus = 'scheduled' | 'running' | 'completed' | 'disabled' | 'failed';

export interface RuntimeCronRecord {
  id: string;
  prompt: string;
  schedule: { type: 'cron'; expression: string } | { type: 'at'; at: string };
  target: RuntimeCronTarget;
  enabled: boolean;
  status: RuntimeCronStatus;
  createdAt: string;
  updatedAt: string;
  lastFiredAt?: string;
  nextRunAt?: string;
  lastError?: string;
  runId?: string;
}

export interface RuntimeCronRegistry {
  version: 1;
  crons: Record<string, RuntimeCronRecord>;
}
const registryIds = new WeakMap<RuntimeCronRegistry, Set<string>>();

export function cronDir(config: AppConfig): string {
  return path.join(stateDir(config), 'cron');
}

export function cronRegistryPath(config: AppConfig): string {
  return path.join(cronDir(config), 'registry.json');
}

export function loadCronRegistry(config: AppConfig, now = new Date()): RuntimeCronRegistry {
  const crons: Record<string, RuntimeCronRecord> = Object.create(null);
  for (const row of getStateDb(config).prepare('SELECT * FROM crons ORDER BY id').all()) {
    const record = trackStateRecord(normalizeRuntimeCron(cronFromRow(row), now));
    crons[record.id] = record;
  }
  const registry: RuntimeCronRegistry = { version: 1, crons };
  registryIds.set(registry, new Set(Object.keys(crons)));
  return registry;
}

function cronPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const { schedule, ...rest } = patch;
  if (schedule) {
    const value = schedule as RuntimeCronRecord['schedule'];
    rest.scheduleType = value.type;
    rest.scheduleValue = value.type === 'cron' ? value.expression : value.at;
  }
  return rest;
}

export function saveCronRegistry(config: AppConfig, registry: RuntimeCronRegistry): void {
  const db = getStateDb(config);
  stateTransaction(db, () => {
    for (const id of registryIds.get(registry) || []) {
      if (!Object.hasOwn(registry.crons, id)) db.prepare('DELETE FROM crons WHERE id = ?').run(id);
    }
    for (const record of Object.values(registry.crons)) {
      validateRuntimeCron(record);
      if (db.prepare('SELECT id FROM crons WHERE id = ?').get(record.id))
        patchStateRow(db, 'crons', cronFields, record.id, cronPatch(changedStateFields(record)));
      else insertStateRow(db, 'crons', cronFields, cronToRow(record));
    }
  });
  for (const record of Object.values(registry.crons)) trackStateRecord(record);
  registryIds.set(registry, new Set(Object.keys(registry.crons)));
}

export function getCron(config: AppConfig, id: string): RuntimeCronRecord {
  const row = getStateDb(config).prepare('SELECT * FROM crons WHERE id = ?').get(id);
  if (!row) throw new Error(`cron not found: ${id}`);
  return trackStateRecord(normalizeRuntimeCron(cronFromRow(row)));
}

export function putCron(config: AppConfig, record: RuntimeCronRecord): RuntimeCronRecord {
  const db = getStateDb(config);
  return stateTransaction(db, () => {
    if (db.prepare('SELECT id FROM crons WHERE id = ?').get(record.id))
      return patchCronInTransaction(config, record.id, changedStateFields(record));
    const normalized = normalizeRuntimeCron({ ...record, updatedAt: new Date().toISOString() });
    insertStateRow(db, 'crons', cronFields, cronToRow(normalized));
    return trackStateRecord(normalized);
  });
}

export function patchCron(
  config: AppConfig,
  id: string,
  patch: Partial<RuntimeCronRecord>,
  now = new Date(),
): RuntimeCronRecord {
  return stateTransaction(getStateDb(config), () => patchCronInTransaction(config, id, patch, now));
}

function patchCronInTransaction(
  config: AppConfig,
  id: string,
  patch: Partial<RuntimeCronRecord>,
  now = new Date(),
): RuntimeCronRecord {
  const db = getStateDb(config);
  const row = db.prepare('SELECT * FROM crons WHERE id = ?').get(id);
  if (!row) throw new Error(`cron not found: ${id}`);
  const current = trackStateRecord(cronFromRow(row));
  const normalized = normalizeRuntimeCron(
    { ...current, ...patch, id, updatedAt: now.toISOString() },
    now,
  );
  Object.assign(current, normalized);
  patchStateRow(db, 'crons', cronFields, id, cronPatch(changedStateFields(current)));
  return trackStateRecord(normalized);
}

export function deleteCron(config: AppConfig, id: string): void {
  const result = getStateDb(config).prepare('DELETE FROM crons WHERE id = ?').run(id);
  if (!result.changes) throw new Error(`cron not found: ${id}`);
}

export function claimCronRun(
  config: AppConfig,
  id: string,
  now = new Date(),
): RuntimeCronRecord | undefined {
  const db = getStateDb(config);
  return stateTransaction(db, () => {
    const row = db
      .prepare(
        "SELECT * FROM crons WHERE id = ? AND enabled = 1 AND status IN ('scheduled','failed') AND nextRunAt <= ?",
      )
      .get(id, now.toISOString());
    if (!row) return undefined;
    return patchCronInTransaction(
      config,
      id,
      {
        status: 'running',
        runId: randomUUID(),
        lastFiredAt: now.toISOString(),
        lastError: undefined,
      },
      now,
    );
  });
}

export function patchCronRun(
  config: AppConfig,
  id: string,
  runId: string,
  patch: Partial<RuntimeCronRecord>,
  now = new Date(),
): RuntimeCronRecord | undefined {
  const db = getStateDb(config);
  return stateTransaction(db, () => {
    const row = db
      .prepare("SELECT id FROM crons WHERE id = ? AND runId = ? AND status = 'running'")
      .get(id, runId);
    if (!row) return undefined;
    if (
      Object.hasOwn(patch, 'runId') &&
      patch.runId !== runId &&
      (patch.status === undefined || patch.status === 'running')
    )
      throw new Error('cannot replace or clear an active cron run token');
    return patchCronInTransaction(config, id, patch, now);
  });
}

export const finishCronRun = patchCronRun;

export function recoverRunningCrons(config: AppConfig, now = new Date()): number {
  // Never blindly replay possibly completed external effects after a restart.
  // Users can explicitly re-enable an interrupted cron after inspecting it.
  return Number(
    getStateDb(config)
      .prepare(`UPDATE crons SET status = 'failed', enabled = 0,
    nextRunAt = NULL, runId = NULL, updatedAt = ?, lastError = ? WHERE status = 'running'`)
      .run(
        now.toISOString(),
        'Cron execution interrupted by daemon restart; disabled to avoid replay. Inspect the result and explicitly re-enable to retry.',
      ).changes,
  );
}

export function normalizeRuntimeCron(
  record: RuntimeCronRecord,
  now = new Date(),
): RuntimeCronRecord {
  const normalized = { ...record };
  if (normalized.status === 'completed') normalized.enabled = false;
  normalized.status = normalized.enabled
    ? ['running', 'failed'].includes(normalized.status)
      ? normalized.status
      : 'scheduled'
    : ['completed', 'failed'].includes(normalized.status)
      ? normalized.status
      : 'disabled';
  if (normalized.status !== 'running') normalized.runId = undefined;
  normalized.nextRunAt = normalized.enabled ? computeNextRunAt(normalized, now) : undefined;
  validateRuntimeCron(normalized);
  return normalized;
}

export function computeNextRunAt(record: RuntimeCronRecord, now = new Date()): string | undefined {
  if (!record.enabled) return undefined;
  if (record.schedule.type === 'at') {
    if (record.lastFiredAt) return undefined;
    const at = parseAtDate(record.schedule.at);
    return at?.toISOString();
  }
  const existing = record.nextRunAt ? Date.parse(record.nextRunAt) : NaN;
  if (Number.isFinite(existing) && existing <= now.getTime()) return record.nextRunAt;
  const next = nextCronDate(record.schedule.expression, now);
  return next?.toISOString();
}

export function validateRuntimeCron(record: RuntimeCronRecord): void {
  if (typeof record.id !== 'string' || !/^[A-Za-z0-9._:-]+$/.test(record.id))
    throw new Error('cron id may only contain letters, numbers, dot, underscore, colon, and dash');
  if (typeof record.prompt !== 'string' || !record.prompt.trim())
    throw new Error('cron prompt is required');
  if (
    typeof record.target !== 'string' ||
    (record.target !== 'main' &&
      record.target !== 'new' &&
      !/^session:[A-Za-z0-9._:-]+$/.test(record.target))
  )
    throw new Error(`invalid cron target: ${record.target}`);
  if (!record.schedule || !['cron', 'at'].includes(record.schedule.type))
    throw new Error('invalid cron schedule type');
  if (record.schedule.type === 'cron') {
    if (!nextCronDate(record.schedule.expression, new Date()))
      throw new Error('invalid cron expression');
  } else if (!parseAtDate(record.schedule.at)) {
    throw new Error('invalid --at time');
  }
}

export function parseAtDate(value: string): Date | null {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(value)
    ? value.replace(' ', 'T')
    : value;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function makeRuntimeCron(fields: {
  id: string;
  prompt: string;
  schedule: RuntimeCronRecord['schedule'];
  target?: RuntimeCronTarget;
  enabled?: boolean;
}): RuntimeCronRecord {
  const now = new Date().toISOString();
  return normalizeRuntimeCron({
    id: fields.id,
    prompt: fields.prompt,
    schedule: fields.schedule,
    target: fields.target || 'main',
    enabled: fields.enabled ?? true,
    status: fields.enabled === false ? 'disabled' : 'scheduled',
    createdAt: now,
    updatedAt: now,
  });
}
