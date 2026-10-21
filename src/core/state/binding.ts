import path from 'node:path';
import { getStateDb } from './db.js';
import { stateDir } from './paths.js';
import type { AppConfig } from '../../types.js';

export interface FeishuChatBinding {
  chatId: string;
  createdAt: string;
  updatedAt: string;
  source?: string;
}

export function bindingPath(config: AppConfig): string {
  return path.join(stateDir(config), 'feishu-chat-binding.json');
}

function bindingFromRow(row: Record<string, unknown>): FeishuChatBinding {
  return {
    chatId: String(row.chatId), createdAt: String(row.createdAt), updatedAt: String(row.updatedAt),
    source: row.source == null ? undefined : String(row.source),
  };
}

export function readFeishuChatBinding(config: AppConfig): FeishuChatBinding | undefined {
  const row = getStateDb(config).prepare('SELECT * FROM visible_binding WHERE singleton = 1').get();
  return row ? bindingFromRow(row) : undefined;
}

export function writeFeishuChatBinding(config: AppConfig, chatId: string, source = 'manual'): FeishuChatBinding {
  if (!chatId.trim()) throw new Error('visible chat binding requires a nonempty chat id');
  const now = new Date().toISOString();
  const row = getStateDb(config).prepare(`INSERT INTO visible_binding(singleton, chatId, createdAt, updatedAt, source)
    VALUES (1, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET
    chatId=excluded.chatId, updatedAt=excluded.updatedAt, source=excluded.source RETURNING *`).get(chatId, now, now, source);
  return bindingFromRow(row!);
}

export function ensureFeishuChatBinding(config: AppConfig, chatId: string, source = 'auto'): FeishuChatBinding {
  if (!chatId.trim()) throw new Error('visible chat binding requires a nonempty chat id');
  const now = new Date().toISOString();
  const db = getStateDb(config);
  db.prepare('INSERT OR IGNORE INTO visible_binding(singleton, chatId, createdAt, updatedAt, source) VALUES (1, ?, ?, ?, ?)').run(chatId, now, now, source);
  return readFeishuChatBinding(config)!;
}
