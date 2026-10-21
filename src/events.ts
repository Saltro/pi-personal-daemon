import crypto from 'node:crypto';
import type { InboundEvent } from './types.js';

interface FeishuMessage {
  message_id?: string;
  message_type?: string;
  content?: unknown;
  chat_id?: string;
  open_chat_id?: string;
  chat_id_v2?: string;
}

interface RawInbound {
  id?: string;
  type?: string;
  text?: string;
  prompt?: string;
  chatId?: string;
  openChatId?: string;
  userId?: string;
  openId?: string;
  message?: FeishuMessage;
  sender?: {
    sender_id?: {
      open_id?: string;
      user_id?: string;
    };
  };
  event?: {
    message?: FeishuMessage;
    sender?: {
      sender_id?: {
        open_id?: string;
        user_id?: string;
      };
    };
  };
  header?: {
    event_id?: string;
    event_type?: string;
  };
  schema?: string;
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

  const message = eventLike.event?.message || eventLike.message;
  const sender = eventLike.event?.sender || eventLike.sender;
  if (message) {
    return {
      id: eventLike.header?.event_id || message.message_id || newId(),
      source,
      kind: 'message',
      chatId: message.chat_id || message.open_chat_id || message.chat_id_v2 || 'feishu-chat',
      userId: sender?.sender_id?.open_id || sender?.sender_id?.user_id,
      messageId: message.message_id,
      text: parseFeishuMessageText(message),
      raw,
    };
  }

  if (eventLike.header?.event_id) {
    return {
      id: eventLike.header.event_id,
      source,
      kind: 'message',
      chatId: eventLike.chatId || 'unknown',
      text: eventLike.text || eventLike.prompt || '',
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

function parseFeishuMessageText(message: FeishuMessage): string {
  if (message.message_type === 'text' && typeof message.content === 'string') {
    try {
      const parsed = JSON.parse(message.content) as { text?: string };
      return parsed.text || message.content;
    } catch {
      return message.content;
    }
  }
  if (message.message_type === 'post' && typeof message.content === 'string') {
    try {
      const parsed = JSON.parse(message.content) as { title?: string; content?: Array<Array<{ tag?: string; text?: string }>> };
      const text = parsed.content?.flat().map(item => item.text).filter(Boolean).join('') || '';
      return [parsed.title, text].filter(Boolean).join('\n') || message.content;
    } catch {
      return message.content;
    }
  }
  if (typeof message.content === 'string') return message.content;
  return JSON.stringify(message.content ?? message);
}

export function toAgentPrompt(event: InboundEvent, channelLabel = 'channel'): string {
  const sendInstruction = `To send a visible ${channelLabel} reply, run: pi-personal-daemon send --stdin`;
  const returnInstruction = 'To report back to the main agent session, run: pi-personal-daemon return --stdin';
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
  ].filter(Boolean).join('\n');
}

export function toPiPrompt(event: InboundEvent): string {
  return toAgentPrompt(event, 'Feishu');
}
