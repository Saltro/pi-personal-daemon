import type { ChannelAdapter } from '../../core/channels/registry.js';
import { ensureFeishuChatBinding, readFeishuChatBinding } from '../../core/state/binding.js';
import type { AppConfig, InboundEvent, OutboundReply, Sender } from '../../types.js';

class StdioSender implements Sender {
  async send(reply: OutboundReply): Promise<{ ok: true }> {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${reply.text}\n`, error => error ? reject(error) : resolve());
    });
    return { ok: true };
  }
}

export class StdioChannel implements ChannelAdapter {
  readonly type = 'stdio';
  readonly label = 'terminal';
  readonly sender = new StdioSender();

  constructor(private config: AppConfig) {}

  async start(): Promise<void> {}
  close(): void {}

  bindInbound(event: InboundEvent): void {
    if (event.kind === 'message' && !readFeishuChatBinding(this.config)) {
      ensureFeishuChatBinding(this.config, event.chatId || 'stdio', 'auto');
    }
  }

  shouldDebounce(): boolean { return false; }
  dedupeKey(): string | null { return null; }
}
