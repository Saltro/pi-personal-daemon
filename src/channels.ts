import { ensureOutputBinding, readOutputBinding } from './output-binding.js';
import { startFeishuWsReceiver } from './feishu-ws.js';
import { startHttpReceiver } from './receivers.js';
import { createSender } from './sender.js';
import type { AppConfig, InboundEvent, OutboundReply, Sender } from './types.js';

export interface ChannelAdapter {
  readonly type: string;
  readonly label: string;
  readonly sender: Sender;
  start(onEvent: (event: InboundEvent) => Promise<void>): Promise<void>;
  close(): void;
  bindInbound(event: InboundEvent): void;
  shouldDebounce(event: InboundEvent): boolean;
  dedupeKey(event: InboundEvent): string | null;
}

export type ChannelFactory = (config: AppConfig) => ChannelAdapter;
const factories = new Map<string, ChannelFactory>();

export function registerChannelAdapter(type: string, factory: ChannelFactory): void {
  if (factories.has(type)) throw new Error(`Channel adapter already registered: ${type}`);
  factories.set(type, factory);
}

export function createChannelAdapter(config: AppConfig): ChannelAdapter {
  const type = config.channel?.type || 'feishu';
  const factory = factories.get(type);
  if (!factory) throw new Error(`Unknown channel adapter: ${type}`);
  return factory(config);
}

class FeishuChannel implements ChannelAdapter {
  readonly type = 'feishu';
  readonly label = 'Feishu';
  readonly sender: Sender;
  private closed = false;
  private http: ReturnType<typeof startHttpReceiver> = null;
  private ws: Awaited<ReturnType<typeof startFeishuWsReceiver>> = null;

  constructor(private config: AppConfig) {
    this.sender = createSender(config);
  }

  async start(onEvent: (event: InboundEvent) => Promise<void>): Promise<void> {
    if (this.closed) return;
    if (this.config.feishu.eventMode !== 'ws') this.http = startHttpReceiver(this.config, onEvent);
    if (this.config.feishu.eventMode !== 'webhook') {
      const ws = await startFeishuWsReceiver(this.config, onEvent);
      if (this.closed) ws?.close({ force: true });
      else this.ws = ws;
    }
  }

  close(): void {
    this.closed = true;
    this.http?.close();
    this.ws?.close({ force: true });
  }

  bindInbound(event: InboundEvent): void {
    if (event.kind !== 'message' || !event.messageId || !event.chatId || !event.source.includes('feishu')) return;
    if (readOutputBinding(this.config)) return;
    ensureOutputBinding(this.config, event.chatId, 'auto');
    console.error(`[channel] feishu chat bound chat=${event.chatId}`);
  }

  shouldDebounce(event: InboundEvent): boolean {
    return event.kind === 'message' && event.source.includes('feishu');
  }

  dedupeKey(event: InboundEvent): string | null {
    if (event.kind !== 'message') return null;
    return event.messageId ? `message:${event.messageId}` : event.source.includes('feishu') ? `event:${event.id}` : null;
  }
}

class StdioSender implements Sender {
  async send(reply: OutboundReply): Promise<{ ok: true }> {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${reply.text}\n`, error => error ? reject(error) : resolve());
    });
    return { ok: true };
  }
}

class StdioChannel implements ChannelAdapter {
  readonly type = 'stdio';
  readonly label = 'terminal';
  readonly sender = new StdioSender();

  constructor(private config: AppConfig) {}

  async start(): Promise<void> {}
  close(): void {}

  bindInbound(event: InboundEvent): void {
    if (event.kind === 'message' && !readOutputBinding(this.config)) {
      ensureOutputBinding(this.config, event.chatId || 'stdio', 'auto');
    }
  }

  shouldDebounce(): boolean { return false; }
  dedupeKey(): string | null { return null; }
}

registerChannelAdapter('feishu', config => new FeishuChannel(config));
registerChannelAdapter('stdio', config => new StdioChannel(config));
