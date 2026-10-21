import { normalizeInbound } from './events.js';
import { claimCronRun, loadCronRegistry, patchCron, patchCronRun, recoverRunningCrons, normalizeRuntimeCron, type RuntimeCronRecord } from './cron-registry.js';
import { callbackQueuePath } from './session-callbacks.js';
import { getSession, makeSessionId, newSessionRecord, insertSession, type ParentCallback, type PersonalSessionRecord } from './session-registry.js';
import { runSessionPrompt, selectSessionAgent } from './session-service.js';
import type { AppConfig, InboundEvent } from './types.js';

const POLL_MS = 1000;

export class RuntimeCronDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<string>();

  constructor(private config: AppConfig, private onMainEvent: (event: InboundEvent) => Promise<void>) {}

  start(): void {
    if (this.timer) return;
    recoverRunningCrons(this.config);
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
    const claimed = claimCronRun(this.config, record.id);
    if (!claimed) return;
    record = claimed;
    console.error(`[runtime-cron] fire id=${record.id} target=${record.target}`);
    try {
      await dispatchRuntimeCron(this.config, record, this.onMainEvent);
      finishClaimedRuntimeCron(this.config, record, undefined);
    } catch (error) {
      finishClaimedRuntimeCron(this.config, record, error instanceof Error ? error.message : String(error));
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
  return patchCron(config, id, { status: 'running', lastFiredAt: now.toISOString(), lastError: undefined }, now);
}

export function markRuntimeCronFinished(config: AppConfig, id: string, error?: string, now = new Date()): RuntimeCronRecord {
  const record = loadCronRegistry(config, now).crons[id];
  if (!record) throw new Error(`cron not found: ${id}`);
  if (error) return patchCron(config, id, { status: 'failed', lastError: error }, now);
  if (record.schedule.type === 'at') return patchCron(config, id, { enabled: false, status: 'completed', nextRunAt: undefined, lastError: undefined }, now);
  const next = normalizeRuntimeCron({ ...record, status: 'scheduled', nextRunAt: undefined, lastError: undefined }, now);
  return patchCron(config, id, { status: next.status, nextRunAt: next.nextRunAt, lastError: undefined }, now);
}

function finishClaimedRuntimeCron(config: AppConfig, claimed: RuntimeCronRecord, error?: string, now = new Date()): RuntimeCronRecord | undefined {
  if (!claimed.runId) throw new Error(`claimed cron has no run token: ${claimed.id}`);
  const current = loadCronRegistry(config, now).crons[claimed.id];
  if (!current || current.runId !== claimed.runId || current.status !== 'running') return undefined;
  const patch: Partial<RuntimeCronRecord> = error
    ? { status: 'failed', lastError: error }
    : current.schedule.type === 'at'
      ? { enabled: false, status: 'completed', nextRunAt: undefined, lastError: undefined }
      : { status: 'scheduled', nextRunAt: normalizeRuntimeCron({ ...current, status: 'scheduled', nextRunAt: undefined }, now).nextRunAt, lastError: undefined };
  return patchCronRun(config, claimed.id, claimed.runId, patch, now);
}

export async function dispatchRuntimeCron(config: AppConfig, record: RuntimeCronRecord, onMainEvent: (event: InboundEvent) => Promise<void>): Promise<void> {
  if (record.target === 'main') {
    await onMainEvent(normalizeInbound({ type: 'wake', id: `cron-${record.id}-${Date.now()}`, prompt: record.prompt, chatId: `cron:${record.id}` }, 'runtime-cron'));
    return;
  }

  if (record.target === 'new') {
    const id = `${record.id}-${makeSessionId()}`;
    const session = insertSession(config, selectSessionAgent(config, newSessionRecord(config, { id, name: `cron:${record.id}`, notify: false, parentCallback: mainParentCallback(config), prompt: record.prompt })));
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
    session = selectSessionAgent(config, newSessionRecord(config, { id: sessionId, name: `cron:${record.id}`, notify: false, parentCallback: mainParentCallback(config), prompt: record.prompt }));
  }
  session.notify = false;
  session.parentCallback = mainParentCallback(config);
  // Notify/callback changes are committed with the run claim, never by a stale pre-run overwrite.
  return session;
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
