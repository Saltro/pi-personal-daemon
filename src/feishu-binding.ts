import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './session-registry.js';
import type { AppConfig } from './types.js';

export interface FeishuChatBinding {
  chatId: string;
  createdAt: string;
  updatedAt: string;
  source?: string;
}

export function bindingPath(config: AppConfig): string {
  return path.join(stateDir(config), 'feishu-chat-binding.json');
}

export function readFeishuChatBinding(config: AppConfig): FeishuChatBinding | undefined {
  const file = bindingPath(config);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as FeishuChatBinding;
}

export function writeFeishuChatBinding(config: AppConfig, chatId: string, source = 'manual'): FeishuChatBinding {
  const now = new Date().toISOString();
  const existing = readFeishuChatBinding(config);
  const binding: FeishuChatBinding = {
    chatId,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    source,
  };
  const file = bindingPath(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(binding, null, 2));
  return binding;
}

export function ensureFeishuChatBinding(config: AppConfig, chatId: string, source = 'auto'): FeishuChatBinding {
  return readFeishuChatBinding(config) || writeFeishuChatBinding(config, chatId, source);
}
