import type { AppConfig, InboundEvent, Sender } from '../../types.js';

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
