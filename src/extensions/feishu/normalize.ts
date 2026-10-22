import { newId, normalizeInbound } from '../../core/events.js';
import type { InboundEvent } from '../../types.js';

interface FeishuMessage {
  message_id?: string;
  message_type?: string;
  content?: unknown;
  chat_id?: string;
  open_chat_id?: string;
  chat_id_v2?: string;
}

interface FeishuSender {
  sender_id?: {
    open_id?: string;
    user_id?: string;
  };
}

interface FeishuEnvelope {
  id?: string;
  text?: string;
  prompt?: string;
  chatId?: string;
  message?: FeishuMessage;
  sender?: FeishuSender;
  event?: {
    message?: FeishuMessage;
    sender?: FeishuSender;
  };
  header?: {
    event_id?: string;
    event_type?: string;
  };
}

export function normalizeFeishuInbound(raw: unknown, source: string): InboundEvent {
  if (!raw || typeof raw !== 'object') return normalizeInbound(raw, source);
  const envelope = raw as FeishuEnvelope;

  const message = envelope.event?.message || envelope.message;
  const sender = envelope.event?.sender || envelope.sender;
  if (message) {
    return {
      id: envelope.header?.event_id || message.message_id || newId(),
      source,
      kind: 'message',
      chatId: message.chat_id || message.open_chat_id || message.chat_id_v2 || 'feishu-chat',
      userId: sender?.sender_id?.open_id || sender?.sender_id?.user_id,
      messageId: message.message_id,
      text: messageText(message),
      raw,
    };
  }

  if (envelope.header?.event_id) {
    return {
      id: envelope.header.event_id,
      source,
      kind: 'message',
      chatId: envelope.chatId || 'unknown',
      text: envelope.text || envelope.prompt || '',
      raw,
    };
  }

  return normalizeInbound(raw, source);
}

function messageText(message: FeishuMessage): string {
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
      const parsed = JSON.parse(message.content) as {
        title?: string;
        content?: Array<Array<{ text?: string }>>;
      };
      const text =
        parsed.content
          ?.flat()
          .map((item) => item.text)
          .filter(Boolean)
          .join('') || '';
      return [parsed.title, text].filter(Boolean).join('\n') || message.content;
    } catch {
      return message.content;
    }
  }
  if (typeof message.content === 'string') return message.content;
  return JSON.stringify(message.content ?? message);
}
