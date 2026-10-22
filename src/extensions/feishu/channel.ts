import type { ChannelAdapter } from '../../core/channels/registry.js';
import { ensureFeishuChatBinding, readFeishuChatBinding } from '../../core/state/binding.js';
import type { AppConfig, InboundEvent, Sender } from '../../types.js';
import { createSender } from './sender.js';
import { startFeishuWsReceiver } from './ws.js';

export class FeishuChannel implements ChannelAdapter {
  readonly type = 'feishu';
  readonly label = 'Feishu';
  readonly sender: Sender;
  private closed = false;
  private ws: Awaited<ReturnType<typeof startFeishuWsReceiver>> = null;

  constructor(private config: AppConfig) {
    this.sender = createSender(config);
  }

  async start(onEvent: (event: InboundEvent) => Promise<void>): Promise<void> {
    if (this.closed) return;
    const ws = await startFeishuWsReceiver(this.config, onEvent);
    if (this.closed) ws?.close({ force: true });
    else this.ws = ws;
  }

  close(): void {
    this.closed = true;
    this.ws?.close({ force: true });
  }

  bindInbound(event: InboundEvent): void {
    if (
      event.kind !== 'message' ||
      !event.messageId ||
      !event.chatId ||
      !event.source.includes('feishu')
    )
      return;
    if (readFeishuChatBinding(this.config)) return;
    ensureFeishuChatBinding(this.config, event.chatId, 'auto');
    console.error(`[channel] feishu chat bound chat=${event.chatId}`);
  }

  shouldDebounce(event: InboundEvent): boolean {
    return event.kind === 'message' && event.source.includes('feishu');
  }

  dedupeKey(event: InboundEvent): string | null {
    if (event.kind !== 'message') return null;
    return event.messageId
      ? `message:${event.messageId}`
      : event.source.includes('feishu')
        ? `event:${event.id}`
        : null;
  }
}
