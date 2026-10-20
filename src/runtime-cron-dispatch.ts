import { normalizeInbound } from './events.js';
import { loadCronRegistry, saveCronRegistry, normalizeRuntimeCron, type RuntimeCronRecord } from './cron-registry.js';
import { callbackQueuePath } from './session-callbacks.js';
import { getSession, makeSessionId, newSessionRecord, putSession, type ParentCallback, type PersonalSessionRecord } from './session-registry.js';
import { runSessionPrompt } from './sessions-cli.js';
import type { AppConfig, InboundEvent } from './types.js';

const POLL_MS = 1000;

export class RuntimeCronDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<string>();

  constructor(private config: AppConfig, private onMainEvent: (event: InboundEvent) => Promise<void>) {}

  start(): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private poll(): void {
    for (const record of dueRuntimeCrons(this.config)) {
      if (this.running.has(record.id)) continue;
      this.running.add(record.id);
      this.fire(record)
        .catch(error => console.error(`[runtime-cron] fire failed id=${record.id}: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => this.running.delete(record.id));
    }
  }

  private async fire(record: RuntimeCronRecord): Promise<void> {
    markRuntimeCronRunning(this.config, record.id);
    console.error(`[runtime-cron] fire id=${record.id} target=${record.target}`);
    try {
      await dispatchRuntimeCron(this.config, record, this.onMainEvent);
      markRuntimeCronFinished(this.config, record.id, undefined);
    } catch (error) {
      markRuntimeCronFinished(this.config, record.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}

export function dueRuntimeCrons(config: AppConfig, now = new Date()): RuntimeCronRecord[] {
  return Object.values(loadCronRegistry(config, now).crons)
    .filter(record => record.enabled && record.status !== 'running' && record.nextRunAt && Date.parse(record.nextRunAt) <= now.getTime())
    .sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt)) || a.id.localeCompare(b.id));
}

export function markRuntimeCronRunning(config: AppConfig, id: string, now = new Date()): RuntimeCronRecord {
  const registry = loadCronRegistry(config, now);
  const record = registry.crons[id];
  if (!record) throw new Error(`cron not found: ${id}`);
  record.status = 'running';
  record.lastFiredAt = now.toISOString();
  record.lastError = undefined;
  record.updatedAt = now.toISOString();
  registry.crons[id] = record;
  saveCronRegistry(config, registry);
  return record;
}

export function markRuntimeCronFinished(config: AppConfig, id: string, error?: string, now = new Date()): RuntimeCronRecord {
  const registry = loadCronRegistry(config, now);
  const record = registry.crons[id];
  if (!record) throw new Error(`cron not found: ${id}`);
  record.lastError = error;
  record.updatedAt = now.toISOString();
  if (error) {
    record.status = 'failed';
    registry.crons[id] = normalizeRuntimeCron(record, now);
  } else if (record.schedule.type === 'at') {
    record.enabled = false;
    record.status = 'completed';
    record.nextRunAt = undefined;
    registry.crons[id] = record;
  } else {
    record.status = 'scheduled';
    record.nextRunAt = undefined;
    registry.crons[id] = normalizeRuntimeCron(record, now);
  }
  saveCronRegistry(config, registry);
  return registry.crons[id];
}

export async function dispatchRuntimeCron(config: AppConfig, record: RuntimeCronRecord, onMainEvent: (event: InboundEvent) => Promise<void>): Promise<void> {
  if (record.target === 'main') {
    await onMainEvent(normalizeInbound({ type: 'wake', id: `cron-${record.id}-${Date.now()}`, prompt: record.prompt, chatId: `cron:${record.id}` }, 'runtime-cron'));
    return;
  }

  if (record.target === 'new') {
    const id = `${record.id}-${makeSessionId()}`;
    const session = putSession(config, newSessionRecord(config, { id, name: `cron:${record.id}`, notify: false, parentCallback: mainParentCallback(config), prompt: record.prompt }));
    await runSessionPrompt(config, session, record.prompt, false);
    return;
  }

  const sessionId = record.target.slice('session:'.length);
  const session = fixedSessionTarget(config, record, sessionId);
  await runSessionPrompt(config, session, record.prompt, false);
}

function fixedSessionTarget(config: AppConfig, record: RuntimeCronRecord, sessionId: string): PersonalSessionRecord {
  let session: PersonalSessionRecord;
  try {
    session = getSession(config, sessionId);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== `session not found: ${sessionId}`) throw error;
    session = newSessionRecord(config, { id: sessionId, name: `cron:${record.id}`, notify: false, parentCallback: mainParentCallback(config), prompt: record.prompt });
  }
  session.notify = false;
  session.parentCallback = mainParentCallback(config);
  return putSession(config, session);
}

function mainParentCallback(config: AppConfig): ParentCallback {
  return {
    sessionId: config.agent.sessionId,
    cwd: config.agent.cwd,
    sessionDir: config.agent.sessionDir,
    queuePath: callbackQueuePath(config, config.agent.sessionId),
    createdAt: new Date().toISOString(),
  };
}
