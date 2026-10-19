import { toPiPrompt } from './events.js';
import { ensureFeishuChatBinding, readFeishuChatBinding } from './feishu-binding.js';
import { drainParentNotifications, noticeToInbound } from './session-callbacks.js';
import { PiRpcRunner } from './pi-runner.js';
import { createSender } from './sender.js';
import { readCurrentContext, recordContextUsage, writeCurrentContext } from './runtime-context.js';
import { startHttpReceiver, startStdinReceiver } from './receivers.js';
import { WakeupScheduler } from './scheduler.js';
import { startFeishuWsReceiver } from './feishu-ws.js';
import type { Interface } from 'node:readline';
import type { Server } from 'node:http';
import type { AppConfig, InboundEvent, Sender } from './types.js';

const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const DEDUPE_MAX_KEYS = 1000;
const PROCESSING_REACTION = 'OK';
const COMPLETION_REACTION = 'DONE';
const USER_MESSAGE_DEBOUNCE_MS = 10_000;

export class PersonalDaemon {
  private runner: PiRpcRunner;
  private sender: Sender;
  private queue: Promise<void> = Promise.resolve();
  private httpServer: Server | null = null;
  private stdinReceiver: Interface | null = null;
  private scheduler: WakeupScheduler;
  private feishuWs: { close(params?: { force?: boolean }): void; getConnectionStatus?: () => unknown } | null = null;
  private callbackPoller: NodeJS.Timeout | null = null;
  private seenInbound = new Map<string, number>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private debouncedMessages: Array<{ event: InboundEvent; dedupeKey: string | null }> = [];

  constructor(private config: AppConfig) {
    this.runner = new PiRpcRunner(config);
    this.sender = createSender(config);
    this.scheduler = new WakeupScheduler(config, event => this.enqueue(event));
  }

  start(): void {
    this.runner.start();
    if (this.config.feishu.eventMode !== 'ws') {
      this.httpServer = startHttpReceiver(this.config, event => this.enqueue(event));
    }
    if (this.config.feishu.eventMode !== 'webhook') {
      startFeishuWsReceiver(this.config, event => this.enqueue(event))
        .then(client => {
          this.feishuWs = client;
        })
        .catch(error => console.error(`[feishu-ws] ${error.stack || error}`));
    }
    this.stdinReceiver = startStdinReceiver(this.config, event => this.enqueue(event));
    this.scheduler.start();
    this.startCallbackPoller();
  }

  enqueue(event: InboundEvent): Promise<void> {
    if (event.source !== 'session-callback') this.deliverCallbackNotifications();
    const dedupeKey = this.dedupeKey(event);
    if (dedupeKey && this.isDuplicate(dedupeKey)) {
      console.error(`[daemon] duplicate skipped event=${event.id} key=${dedupeKey}`);
      return this.queue;
    }
    if (this.shouldDebounce(event)) {
      this.debounceUserMessage(event, dedupeKey);
      return this.queue;
    }
    this.enqueueImmediate(event, dedupeKey);
    return this.queue;
  }

  private enqueueImmediate(event: InboundEvent, dedupeKeys: string | string[] | null = null): void {
    const keys = Array.isArray(dedupeKeys) ? dedupeKeys : dedupeKeys ? [dedupeKeys] : [];
    this.queue = this.queue.then(() => this.handleEvent(event)).catch(error => {
      for (const key of keys) this.seenInbound.delete(key);
      console.error(`[daemon] ${error.stack || error}`);
    });
  }

  private shouldDebounce(event: InboundEvent): boolean {
    return event.kind === 'message' && event.source.includes('feishu');
  }

  private debounceUserMessage(event: InboundEvent, dedupeKey: string | null): void {
    this.debouncedMessages.push({ event, dedupeKey });
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flushDebouncedMessages(), USER_MESSAGE_DEBOUNCE_MS);
    console.error(`[daemon] message debounced event=${event.id} batch_size=${this.debouncedMessages.length}`);
  }

  private flushDebouncedMessages(): void {
    this.debounceTimer = null;
    const batch = this.debouncedMessages.splice(0);
    if (!batch.length) return;
    const event = aggregateInboundMessages(batch.map(item => item.event));
    const dedupeKeys = batch.map(item => item.dedupeKey).filter((key): key is string => !!key);
    if (this.runner.isRunning()) {
      this.steerActiveRun(event).catch(error => {
        for (const key of dedupeKeys) this.seenInbound.delete(key);
        console.error(`[daemon] steer failed event=${event.id}: ${error instanceof Error ? error.message : String(error)}`);
        this.enqueueImmediate(event);
      });
      return;
    }
    this.enqueueImmediate(event, dedupeKeys);
  }

  private async steerActiveRun(event: InboundEvent): Promise<void> {
    console.error(`[daemon] prompt steer event=${event.id} text_chars=${event.text.length}`);
    this.bindFeishuChat(event);
    await this.addReaction(event, PROCESSING_REACTION, 'processing');
    writeCurrentContext(this.config, event);
    const response = await this.runner.steer(toPiPrompt(event));
    console.error(`[daemon] prompt steered event=${event.id} disposition=${response.disposition}`);
    this.runner.waitForSettled().then(async () => {
      await this.refreshContextUsage(event.id);
      const context = readCurrentContext(this.config);
      console.error(`[daemon] prompt done event=${event.id} send_count=${context.sendCount || 0}`);
      if (!context.sendCount) console.error(`[daemon] reply not sent event=${event.id} reason=agent_cli_not_called`);
      await this.addReaction(event, COMPLETION_REACTION, 'completion');
    }).catch(error => console.error(`[daemon] steer completion warning event=${event.id}: ${error instanceof Error ? error.message : String(error)}`));
  }

  async handleEvent(event: InboundEvent): Promise<void> {
    if (!event.text?.trim()) return;
    console.error(`[daemon] event ${event.id} kind=${event.kind} chat=${event.chatId} text_chars=${event.text.length}`);
    this.bindFeishuChat(event);
    await this.addReaction(event, PROCESSING_REACTION, 'processing');
    writeCurrentContext(this.config, event);
    await this.refreshContextUsage(event.id);
    const prompt = toPiPrompt(event);
    console.error(`[daemon] prompt start event=${event.id}`);
    await this.runner.promptAndWait(prompt);
    await this.refreshContextUsage(event.id);
    const context = readCurrentContext(this.config);
    console.error(`[daemon] prompt done event=${event.id} send_count=${context.sendCount || 0}`);
    if (!context.sendCount) console.error(`[daemon] reply not sent event=${event.id} reason=agent_cli_not_called`);
    await this.addReaction(event, COMPLETION_REACTION, 'completion');
  }

  private async refreshContextUsage(eventId: string): Promise<void> {
    try {
      const usage = await this.runner.getContextUsage();
      recordContextUsage(this.config, usage);
      console.error(`[daemon] context usage event=${eventId} value=${JSON.stringify(usage.text)} source=${usage.source}`);
    } catch (error) {
      console.error(`[daemon] context usage warning event=${eventId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private bindFeishuChat(event: InboundEvent): void {
    if (event.kind !== 'message' || !event.messageId || !event.chatId) return;
    if (!event.source.includes('feishu')) return;
    if (readFeishuChatBinding(this.config)) return;
    ensureFeishuChatBinding(this.config, event.chatId, 'auto');
    console.error(`[daemon] feishu chat bound chat=${event.chatId}`);
  }

  private async addReaction(event: InboundEvent, emojiType: string, phase: string): Promise<void> {
    if (!this.sender.addReaction) return;
    const messageIds = reactionMessageIds(event);
    for (const messageId of messageIds) {
      try {
        await this.sender.addReaction(messageId, emojiType);
        console.error(`[daemon] reaction ok event=${event.id} message=${messageId} emoji=${emojiType} phase=${phase}`);
      } catch (error) {
        console.error(`[daemon] reaction warning event=${event.id} message=${messageId} emoji=${emojiType} phase=${phase}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private startCallbackPoller(): void {
    this.deliverCallbackNotifications();
    this.callbackPoller = setInterval(() => this.deliverCallbackNotifications(), 2000);
  }

  private deliverCallbackNotifications(): void {
    for (const notice of drainParentNotifications(this.config)) {
      this.enqueue(noticeToInbound(notice));
    }
  }

  private dedupeKey(event: InboundEvent): string | null {
    if (event.kind !== 'message') return null;
    if (event.source.includes('feishu') || event.messageId) return event.messageId ? `message:${event.messageId}` : `event:${event.id}`;
    return null;
  }

  private isDuplicate(key: string): boolean {
    const now = Date.now();
    for (const [seenKey, seenAt] of this.seenInbound) {
      if (now - seenAt > DEDUPE_TTL_MS) this.seenInbound.delete(seenKey);
    }
    if (this.seenInbound.has(key)) return true;
    this.seenInbound.set(key, now);
    if (this.seenInbound.size > DEDUPE_MAX_KEYS) {
      const oldest = this.seenInbound.keys().next().value as string | undefined;
      if (oldest) this.seenInbound.delete(oldest);
    }
    return false;
  }

  async getState(): Promise<unknown> {
    return this.runner.getState();
  }

  async getMessages(): Promise<unknown> {
    return this.runner.getMessages();
  }

  stop(): void {
    this.scheduler.stop();
    if (this.callbackPoller) clearInterval(this.callbackPoller);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.debouncedMessages.length) this.flushDebouncedMessages();
    this.feishuWs?.close({ force: true });
    this.httpServer?.close();
    this.stdinReceiver?.close();
    this.runner.close();
  }
}

function reactionMessageIds(event: InboundEvent): string[] {
  const rawEvents = Array.isArray(event.raw) ? event.raw.filter(isInboundEvent) : [event];
  return Array.from(new Set(rawEvents.map(item => item.messageId).filter((id): id is string => !!id)));
}

function isInboundEvent(value: unknown): value is InboundEvent {
  return typeof value === 'object' && value !== null && 'id' in value && 'text' in value;
}

function aggregateInboundMessages(events: InboundEvent[]): InboundEvent {
  if (events.length === 1) return events[0];
  const first = events[0];
  const last = events[events.length - 1];
  const lines = [
    `Aggregated ${events.length} Feishu inbound messages in receive order.`,
    ...events.flatMap((event, index) => [
      '',
      `Message ${index + 1}:`,
      `source=${event.source}`,
      `event_id=${event.id}`,
      `chat_id=${event.chatId}`,
      event.messageId ? `message_id=${event.messageId}` : undefined,
      event.userId ? `user_id=${event.userId}` : undefined,
      event.text,
    ].filter(Boolean) as string[]),
  ];
  return {
    ...last,
    id: `${first.id}..${last.id}`,
    chatId: last.chatId,
    messageId: last.messageId,
    userId: last.userId,
    text: lines.join('\n'),
    raw: events,
  };
}
