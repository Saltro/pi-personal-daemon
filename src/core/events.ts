import crypto from 'node:crypto';
import type { InboundEvent } from '../types.js';

interface RawInbound {
  id?: string;
  type?: string;
  text?: string;
  prompt?: string;
  chatId?: string;
  openChatId?: string;
  userId?: string;
  openId?: string;
}

export function newId(prefix = 'evt'): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

export function normalizeInbound(raw: unknown, source = 'unknown'): InboundEvent {
  if (!raw || typeof raw !== 'object') {
    return { id: newId(), source, kind: 'message', chatId: source, text: String(raw ?? '') };
  }

  const eventLike = raw as RawInbound;

  if (eventLike.type === 'wake') {
    return {
      id: eventLike.id || newId('wake'),
      source,
      kind: 'wake',
      chatId: eventLike.chatId || 'self',
      text: eventLike.prompt || eventLike.text || '',
      raw,
    };
  }

  if (eventLike.type === 'message' && eventLike.text) {
    return {
      id: eventLike.id || newId(),
      source,
      kind: 'message',
      chatId: eventLike.chatId || eventLike.openChatId || 'mock-chat',
      userId: eventLike.userId || eventLike.openId,
      text: eventLike.text,
      raw,
    };
  }

  return {
    id: eventLike.id || newId(),
    source,
    kind: 'message',
    chatId: eventLike.chatId || 'unknown',
    text: eventLike.text || eventLike.prompt || JSON.stringify(raw),
    raw,
  };
}

export function toAgentPrompt(event: InboundEvent, channelLabel = 'channel'): string {
  const sendInstruction = `To send a visible ${channelLabel} reply, run: retriever send --stdin`;
  const returnInstruction =
    'To report back to the main agent session, run: retriever return --stdin';
  if (event.kind === 'wake') {
    return [sendInstruction, returnInstruction, '', event.text].filter(Boolean).join('\n');
  }
  return [
    `${channelLabel} inbound message`,
    `source=${event.source}`,
    `event_id=${event.id}`,
    `chat_id=${event.chatId}`,
    event.messageId ? `message_id=${event.messageId}` : undefined,
    event.userId ? `user_id=${event.userId}` : undefined,
    sendInstruction,
    returnInstruction,
    '',
    event.text,
  ]
    .filter(Boolean)
    .join('\n');
}
