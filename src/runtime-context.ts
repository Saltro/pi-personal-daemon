import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AppConfig, InboundEvent, RuntimeContext } from './types.js';

export function defaultContextFile(): string {
  return path.join(os.tmpdir(), 'pi-personal-daemon-current-context.json');
}

export function contextFile(config: AppConfig): string {
  return config.runtime.contextFile || defaultContextFile();
}

export function writeCurrentContext(config: AppConfig, event: InboundEvent): RuntimeContext {
  const file = contextFile(config);
  const context: RuntimeContext = {
    chatId: event.chatId,
    eventId: event.id,
    messageId: event.messageId,
    source: event.source,
    kind: event.kind,
    textChars: event.text.length,
    startedAt: new Date().toISOString(),
    sendCount: 0,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(context, null, 2));
  return context;
}

export function readCurrentContext(config: AppConfig): RuntimeContext {
  const file = contextFile(config);
  if (!fs.existsSync(file)) throw new Error(`current message context not found: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as RuntimeContext;
}

export function recordContextSend(config: AppConfig): RuntimeContext {
  const context = readCurrentContext(config);
  context.sendCount = (context.sendCount || 0) + 1;
  context.lastSentAt = new Date().toISOString();
  fs.writeFileSync(contextFile(config), JSON.stringify(context, null, 2));
  return context;
}
