import fs from 'node:fs';
import path from 'node:path';
import { newId } from './events.js';
import { stateDir, type PersonalSessionRecord, type ParentCallback } from './session-registry.js';
import type { AppConfig, InboundEvent } from './types.js';

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

export function writeParentNotification(config: AppConfig, record: PersonalSessionRecord): string | undefined {
  if (!record.parentCallback) return undefined;
  const notice: ParentCompletionNotice = {
    type: 'session.completed',
    id: newId('session_callback'),
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
  return writeNoticeFile(config, record.parentCallback, notice, record.id);
}

export function writeParentReturnNotification(config: AppConfig, parent: ParentCallback, text: string, childSessionId?: string): string {
  const notice: ParentReturnNotice = {
    type: 'session.return',
    id: newId('session_return'),
    createdAt: new Date().toISOString(),
    parent,
    child: childSessionId ? { id: childSessionId, sessionId: childSessionId } : undefined,
    text,
  };
  return writeNoticeFile(config, parent, notice, childSessionId || 'return');
}

export function drainParentNotifications(config: AppConfig): ParentCallbackNotice[] {
  const root = callbackRoot(config);
  if (!fs.existsSync(root)) return [];
  const notices: ParentCallbackNotice[] = [];
  for (const parentDir of fs.readdirSync(root)) {
    const dir = path.join(root, parentDir);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort()) {
      const file = path.join(dir, name);
      try {
        notices.push(JSON.parse(fs.readFileSync(file, 'utf8')) as ParentCallbackNotice);
        fs.unlinkSync(file);
      } catch (error) {
        const badFile = `${file}.bad-${Date.now()}`;
        fs.renameSync(file, badFile);
        console.error(`[session-callback] quarantined ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
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
    `Child Pi session ${notice.child.id} ${notice.child.status}.`,
    `session_id=${notice.child.sessionId}`,
    `cwd=${notice.child.cwd}`,
    notice.child.sessionDir ? `session_dir=${notice.child.sessionDir}` : undefined,
    `log=${notice.child.logPath}`,
    notice.child.exitCode === undefined ? undefined : `exit_code=${notice.child.exitCode}`,
    notice.child.error ? `error=${notice.child.error}` : undefined,
    notice.child.lastResult ? `last_result:\n${notice.child.lastResult.slice(-3000)}` : undefined,
    '',
    'Decide the next action: send Feishu, inspect child history, continue the child session, or record the result.',
  ].filter(Boolean).join('\n');
}

function returnNoticeText(notice: ParentReturnNotice): string {
  return [
    notice.child?.id ? `Child Pi session ${notice.child.id} returned:` : 'Child Pi session returned:',
    notice.text,
  ].join('\n');
}

function writeNoticeFile(config: AppConfig, parent: ParentCallback, notice: ParentCallbackNotice, name: string): string {
  const dir = parent.queuePath || callbackQueuePath(config, parent.sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${safeName(name)}.json`);
  fs.writeFileSync(file, JSON.stringify(notice, null, 2));
  return file;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 160) || 'session';
}
