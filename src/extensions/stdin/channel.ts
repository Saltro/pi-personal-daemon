import readline, { type Interface } from 'node:readline';
import type { ChannelAdapter } from '../../core/channels/registry.js';
import { normalizeInbound } from '../../core/events.js';
import { ensureFeishuChatBinding, readFeishuChatBinding } from '../../core/state/binding.js';
import type { AppConfig, InboundEvent, OutboundReply, Sender } from '../../types.js';

class StdoutSender implements Sender {
  async send(reply: OutboundReply): Promise<{ ok: true }> {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${reply.text}\n`, (error) => (error ? reject(error) : resolve()));
    });
    return { ok: true };
  }
}

/** Terminal channel: plain text or JSON lines on stdin, replies on stdout. */
export class StdinChannel implements ChannelAdapter {
  readonly type = 'stdin';
  readonly label = 'terminal';
  readonly sender = new StdoutSender();
  private receiver: Interface | null = null;

  constructor(private config: AppConfig) {}

  async start(onEvent: (event: InboundEvent) => Promise<void>): Promise<void> {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const payload = trimmed.startsWith('{')
          ? JSON.parse(trimmed)
          : { type: 'message', text: trimmed, chatId: 'stdin' };
        onEvent(normalizeInbound(payload, 'stdin')).catch((error) =>
          console.error(`[stdin] ${error.stack || error}`),
        );
      } catch (error) {
        console.error(
          `[stdin] bad input: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    this.receiver = rl;
    console.error('[stdin] ready; type text or JSON lines');
  }

  close(): void {
    this.receiver?.close();
    this.receiver = null;
  }

  bindInbound(event: InboundEvent): void {
    if (event.kind === 'message' && !readFeishuChatBinding(this.config)) {
      ensureFeishuChatBinding(this.config, event.chatId || 'stdin', 'auto');
    }
  }

  shouldDebounce(): boolean {
    return false;
  }

  dedupeKey(): string | null {
    return null;
  }
}
