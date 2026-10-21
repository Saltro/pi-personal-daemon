import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getStateDb, stateTransaction } from '../state/db.js';
import { stateDir } from '../state/paths.js';
import type { PersonalSessionRecord, ParentCallback } from './registry.js';
import type { AppConfig, InboundEvent } from '../../types.js';

export type ParentCallbackNotice = ParentCompletionNotice | ParentReturnNotice;

export interface ParentCompletionNotice {
  type: 'session.completed';
  id: string;
  createdAt: string;
  parent: ParentCallback;
  child: {
    id: string;
    sessionId: string;
    cwd: string;
    sessionDir?: string;
    status: string;
    logPath: string;
    lastResult?: string;
    exitCode?: number | null;
    error?: string;
    updatedAt: string;
  };
}

export interface ParentReturnNotice {
  type: 'session.return';
  id: string;
  createdAt: string;
  parent: ParentCallback;
  child?: {
    id?: string;
    sessionId?: string;
  };
  text: string;
}

export function callbackRoot(config: AppConfig): string {
  return path.join(stateDir(config), 'session-callbacks');
}

export function callbackQueuePath(config: AppConfig, parentSessionId: string): string {
  return path.join(callbackRoot(config), safeName(parentSessionId));
}

export function detectParentCallback(config: AppConfig): ParentCallback | undefined {
  const sessionId = process.env.PI_SESSION_ID;
  const sessionFile = process.env.PI_SESSION_FILE;
  if (!sessionId && !sessionFile) return undefined;
  const parentSessionId = sessionId || path.basename(sessionFile || 'parent');
  return {
    sessionId: parentSessionId,
    sessionFile,
    cwd: process.cwd(),
    sessionDir: config.agent.sessionDir,
    queuePath: callbackQueuePath(config, parentSessionId),
    createdAt: new Date().toISOString(),
  };
}

export function makeParentNotification(record: PersonalSessionRecord): ParentCompletionNotice | undefined {
  if (!record.parentCallback) return undefined;
  return {
    type: 'session.completed',
    id: `session_callback_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    parent: record.parentCallback,
    child: {
      id: record.id,
      sessionId: record.sessionId,
      cwd: record.cwd,
      sessionDir: record.sessionDir,
      status: record.status,
      logPath: record.logPath,
      lastResult: record.lastResult,
      exitCode: record.exitCode,
      error: record.error,
      updatedAt: record.updatedAt,
    },
  };
}

export function writeParentNotification(config: AppConfig, record: PersonalSessionRecord): string | undefined {
  const notice = makeParentNotification(record);
  return notice ? persistParentNotification(config, notice) : undefined;
}

export function writeParentReturnNotification(config: AppConfig, parent: ParentCallback, text: string, childSessionId?: string): string {
  const notice: ParentReturnNotice = {
    type: 'session.return',
    id: `session_return_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    parent,
    child: childSessionId ? { id: childSessionId, sessionId: childSessionId } : undefined,
    text,
  };
  return persistParentNotification(config, notice);
}

export const MAX_PARENT_NOTIFICATION_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

export function claimParentNotifications(config: AppConfig, limit?: number): ParentCallbackNotice[] {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) throw new Error('parent notification claim limit must be a positive integer');
  const db = getStateDb(config);
  return stateTransaction(db, () => {
    const now = new Date().toISOString();
    const rows = db.prepare(`SELECT id, payload FROM parent_notifications
      WHERE status = 'pending' AND attempts < ? AND availableAt <= ?
      ORDER BY createdAt, id ${limit === undefined ? '' : 'LIMIT ?'}`)
      .all(MAX_PARENT_NOTIFICATION_ATTEMPTS, now, ...(limit === undefined ? [] : [limit]));
    // Decode first so an invalid stored payload cannot leave partially claimed rows.
    const notices = rows.map(row => JSON.parse(String(row.payload)) as ParentCallbackNotice);
    const claim = db.prepare("UPDATE parent_notifications SET status='claimed', attempts=attempts+1, claimedAt=? WHERE id=? AND status='pending'");
    for (const row of rows) claim.run(now, String(row.id));
    return notices;
  });
}

export function acknowledgeParentNotification(config: AppConfig, id: string): void {
  getStateDb(config).prepare("UPDATE parent_notifications SET status='delivered', deliveredAt=?, claimedAt=NULL, lastError=NULL WHERE id=? AND status='claimed'").run(new Date().toISOString(), id);
}

export function releaseParentNotification(config: AppConfig, id: string): void {
  const db = getStateDb(config);
  stateTransaction(db, () => releaseClaim(db, id, new Date(), 'Callback processing failed; released for retry.'));
}

export function recoverParentNotifications(config: AppConfig): number {
  // One daemon owns consumption. Call once on startup, not on every DB open:
  // independent send/return CLIs must never steal an in-flight daemon claim.
  const db = getStateDb(config);
  return stateTransaction(db, () => {
    const rows = db.prepare("SELECT id FROM parent_notifications WHERE status='claimed'").all();
    const now = new Date();
    for (const row of rows) releaseClaim(db, String(row.id), now, 'Callback delivery interrupted by daemon restart.');
    return rows.length;
  });
}

function releaseClaim(db: ReturnType<typeof getStateDb>, id: string, now: Date, reason: string): void {
  const row = db.prepare("SELECT attempts FROM parent_notifications WHERE id=? AND status='claimed'").get(id);
  if (!row) return;
  const attempts = Number(row.attempts);
  const exhausted = attempts >= MAX_PARENT_NOTIFICATION_ATTEMPTS;
  const availableAt = new Date(now.getTime() + RETRY_DELAY_MS * 2 ** Math.max(0, attempts - 1)).toISOString();
  db.prepare('UPDATE parent_notifications SET status=?, availableAt=?, claimedAt=NULL, lastError=? WHERE id=? AND status=?').run(
    exhausted ? 'failed' : 'pending', availableAt,
    exhausted ? `${reason} Retry limit (${MAX_PARENT_NOTIFICATION_ATTEMPTS}) exhausted; retained for inspection.` : reason,
    id, 'claimed',
  );
}

// Deprecated destructive drain semantics are preserved for old callers. The
// daemon uses claim/ack instead and acknowledges only after main completion.
export function drainParentNotifications(config: AppConfig): ParentCallbackNotice[] {
  const notices = claimParentNotifications(config);
  for (const notice of notices) acknowledgeParentNotification(config, notice.id);
  return notices;
}

export function noticeToInbound(notice: ParentCallbackNotice): InboundEvent {
  const text = notice.type === 'session.return' ? returnNoticeText(notice) : completionNoticeText(notice);
  return {
    id: notice.id,
    source: 'session-callback',
    kind: 'wake',
    chatId: notice.parent.sessionId,
    text,
    raw: notice,
  };
}

function completionNoticeText(notice: ParentCompletionNotice): string {
  return [
    `Child session ${notice.child.id} ${notice.child.status}.`,
    `session_id=${notice.child.sessionId}`,
    `cwd=${notice.child.cwd}`,
    notice.child.sessionDir ? `session_dir=${notice.child.sessionDir}` : undefined,
    `log=${notice.child.logPath}`,
    notice.child.exitCode === undefined ? undefined : `exit_code=${notice.child.exitCode}`,
    notice.child.error ? `error=${notice.child.error}` : undefined,
    notice.child.lastResult ? `last_result:\n${notice.child.lastResult.slice(-3000)}` : undefined,
    '',
    'Decide the next action: send a visible reply, inspect child history, continue the child session, or record the result.',
  ].filter(Boolean).join('\n');
}

function returnNoticeText(notice: ParentReturnNotice): string {
  return [
    notice.child?.id ? `Child session ${notice.child.id} returned:` : 'Child session returned:',
    notice.text,
  ].join('\n');
}

export function persistParentNotification(config: AppConfig, notice: ParentCallbackNotice): string {
  getStateDb(config).prepare('INSERT INTO parent_notifications(id, createdAt, payload, availableAt) VALUES (?, ?, ?, ?)')
    .run(notice.id, notice.createdAt, JSON.stringify(notice), notice.createdAt);
  return notice.id;
}

export function listParentNotifications(config: AppConfig): ParentCallbackNotice[] {
  return getStateDb(config).prepare("SELECT payload FROM parent_notifications WHERE status IN ('pending','claimed') ORDER BY createdAt,id")
    .all().map(row => JSON.parse(String(row.payload)) as ParentCallbackNotice);
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 160) || 'session';
}
