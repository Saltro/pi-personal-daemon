import type { AppConfig, InboundEvent, RuntimeContext } from '../../types.js';
import { contextFields, decodeStateRow, getStateDb } from './db.js';
import { stateDbPath } from './paths.js';

export function writeCurrentContext(config: AppConfig, event: InboundEvent): RuntimeContext {
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
  const row = getStateDb(config)
    .prepare(`INSERT INTO current_context
    (singleton, chatId, eventId, messageId, source, kind, textChars, startedAt, sendCount)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(singleton) DO UPDATE SET chatId=excluded.chatId, eventId=excluded.eventId,
      messageId=excluded.messageId, source=excluded.source, kind=excluded.kind,
      textChars=excluded.textChars, startedAt=excluded.startedAt, sendCount=0,
      lastSentAt=NULL, contextUsage=NULL, contextUsageSource=NULL RETURNING *`)
    .get(
      context.chatId,
      context.eventId,
      context.messageId ?? null,
      context.source,
      context.kind,
      context.textChars,
      context.startedAt,
    );
  if (!row) throw new Error('current context upsert returned no row');
  return decodeStateRow<RuntimeContext>(row, contextFields);
}

export function readCurrentContext(config: AppConfig): RuntimeContext {
  const row = getStateDb(config).prepare('SELECT * FROM current_context WHERE singleton = 1').get();
  if (!row) throw new Error(`current message context not found: ${stateDbPath(config)}`);
  return decodeStateRow<RuntimeContext>(row, contextFields);
}

export function recordContextSend(config: AppConfig, expectedEventId?: string): RuntimeContext {
  const row = getStateDb(config)
    .prepare(`UPDATE current_context SET sendCount = sendCount + 1, lastSentAt = ?
    WHERE singleton = 1 ${expectedEventId === undefined ? '' : 'AND eventId = ?'} RETURNING *`)
    .get(new Date().toISOString(), ...(expectedEventId === undefined ? [] : [expectedEventId]));
  return updatedContext(config, row, expectedEventId);
}

export function recordContextUsage(
  config: AppConfig,
  usage: { text: string; source: string },
  expectedEventId?: string,
): RuntimeContext {
  const row = getStateDb(config)
    .prepare(`UPDATE current_context SET contextUsage = ?, contextUsageSource = ?
    WHERE singleton = 1 ${expectedEventId === undefined ? '' : 'AND eventId = ?'} RETURNING *`)
    .get(usage.text, usage.source, ...(expectedEventId === undefined ? [] : [expectedEventId]));
  return updatedContext(config, row, expectedEventId);
}

function updatedContext(
  config: AppConfig,
  row: Record<string, unknown> | undefined,
  expectedEventId?: string,
): RuntimeContext {
  if (row) return decodeStateRow<RuntimeContext>(row, contextFields);
  const context = readCurrentContext(config);
  throw new Error(
    `current message context ownership changed: expected event ${expectedEventId}, current event ${context.eventId}`,
  );
}
