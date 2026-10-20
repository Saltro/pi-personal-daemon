import fs from 'node:fs';
import path from 'node:path';
import { nextCronDate } from './cron-utils.js';
import { stateDir } from './session-registry.js';
import type { AppConfig } from './types.js';

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
}

export interface RuntimeCronRegistry {
  version: 1;
  crons: Record<string, RuntimeCronRecord>;
}

export function cronDir(config: AppConfig): string {
  return path.join(stateDir(config), 'cron');
}

export function cronRegistryPath(config: AppConfig): string {
  return path.join(cronDir(config), 'registry.json');
}

export function loadCronRegistry(config: AppConfig, now = new Date()): RuntimeCronRegistry {
  const file = cronRegistryPath(config);
  if (!fs.existsSync(file)) return { version: 1, crons: {} };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RuntimeCronRegistry>;
  const crons: Record<string, RuntimeCronRecord> = {};
  for (const [id, record] of Object.entries(raw.crons || {})) crons[id] = normalizeRuntimeCron(record, now);
  return { version: 1, crons };
}

export function saveCronRegistry(config: AppConfig, registry: RuntimeCronRegistry): void {
  const file = cronRegistryPath(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(registry, null, 2));
}

export function getCron(config: AppConfig, id: string): RuntimeCronRecord {
  const record = loadCronRegistry(config).crons[id];
  if (!record) throw new Error(`cron not found: ${id}`);
  return record;
}

export function putCron(config: AppConfig, record: RuntimeCronRecord): RuntimeCronRecord {
  const registry = loadCronRegistry(config);
  record.updatedAt = new Date().toISOString();
  registry.crons[record.id] = normalizeRuntimeCron(record);
  saveCronRegistry(config, registry);
  return registry.crons[record.id];
}

export function deleteCron(config: AppConfig, id: string): void {
  const registry = loadCronRegistry(config);
  if (!registry.crons[id]) throw new Error(`cron not found: ${id}`);
  delete registry.crons[id];
  saveCronRegistry(config, registry);
}

export function normalizeRuntimeCron(record: RuntimeCronRecord, now = new Date()): RuntimeCronRecord {
  const normalized = { ...record };
  if (normalized.status === 'completed') normalized.enabled = false;
  normalized.status = normalized.enabled ? (['running', 'failed'].includes(normalized.status) ? normalized.status : 'scheduled') : (normalized.status === 'completed' ? 'completed' : 'disabled');
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
  if (!/^[A-Za-z0-9._:-]+$/.test(record.id)) throw new Error('cron id may only contain letters, numbers, dot, underscore, colon, and dash');
  if (!record.prompt.trim()) throw new Error('cron prompt is required');
  if (record.target !== 'main' && record.target !== 'new' && !record.target.startsWith('session:')) throw new Error(`invalid cron target: ${record.target}`);
  if (record.schedule.type === 'cron') {
    if (!nextCronDate(record.schedule.expression, new Date())) throw new Error('invalid cron expression');
  } else if (!parseAtDate(record.schedule.at)) {
    throw new Error('invalid --at time');
  }
}

export function parseAtDate(value: string): Date | null {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(value) ? value.replace(' ', 'T') : value;
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
