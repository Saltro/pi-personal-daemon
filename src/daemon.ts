import { toAgentPrompt } from './events.js';
import { createChannelAdapter, type ChannelAdapter } from './channels.js';
import { acknowledgeParentNotification, claimParentNotifications, noticeToInbound, recoverParentNotifications, releaseParentNotification } from './session-callbacks.js';
import { createMainAgentRunner, type AgentRunner } from './agents/index.js';
import { readCurrentContext, recordContextUsage, writeCurrentContext } from './runtime-context.js';
import { RuntimeCronDispatcher } from './runtime-cron-dispatch.js';
import { startStdinReceiver } from './receivers.js';
import { WakeupScheduler } from './scheduler.js';
import type { Interface } from 'node:readline';
import type { AppConfig, InboundEvent } from './types.js';

export interface DaemonOptions {
  runner?: AgentRunner;
  channel?: ChannelAdapter;
  debounceMs?: number;
}

const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const DEDUPE_MAX_KEYS = 1000;
const PROCESSING_REACTION = 'OK';
const COMPLETION_REACTION = 'DONE';
const USER_MESSAGE_DEBOUNCE_MS = 10_000;

export class PersonalDaemon {
  private runner: AgentRunner;
  private channel: ChannelAdapter;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private callbacksRecovered = false;
  private callbackDeliveryScheduled = false;
  private debounceMs: number;
  private stdinReceiver: Interface | null = null;
  private scheduler: WakeupScheduler;
  private runtimeCron: RuntimeCronDispatcher;
  private callbackPoller: NodeJS.Timeout | null = null;
  private seenInbound = new Map<string, number>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private debouncedMessages: Array<{ event: InboundEvent; dedupeKey: string | null }> = [];

  constructor(private config: AppConfig, options: DaemonOptions = {}) {
    this.runner = options.runner || createMainAgentRunner(config);
    this.channel = options.channel || createChannelAdapter(config);
    this.debounceMs = options.debounceMs ?? USER_MESSAGE_DEBOUNCE_MS;
    this.scheduler = new WakeupScheduler(config, event => this.enqueue(event));
    this.runtimeCron = new RuntimeCronDispatcher(config, event => this.enqueue(event));
  }

  start(): void {
    this.runner.start();
    this.channel.start(event => this.enqueue(event))
      .catch(error => console.error(`[channel] ${error.stack || error}`));
    this.stdinReceiver = startStdinReceiver(this.config, event => this.enqueue(event));
    this.scheduler.start();
    this.runtimeCron.start();
    this.startCallbackPoller();
  }

  enqueue(event: InboundEvent): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Daemon is stopped'));
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
    return this.enqueueImmediate(event, dedupeKey);
  }

  private enqueueImmediate(event: InboundEvent, dedupeKeys: string | string[] | null = null): Promise<void> {
    const keys = Array.isArray(dedupeKeys) ? dedupeKeys : dedupeKeys ? [dedupeKeys] : [];
    const task = this.queue.then(async () => {
      if (this.stopped) throw new Error('Daemon stopped before event delivery');
      await this.handleEvent(event);
    });
    this.queue = task.catch(error => {
      for (const key of keys) this.seenInbound.delete(key);
      console.error(`[daemon] ${error.stack || error}`);
    });
    return task;
  }

  private shouldDebounce(event: InboundEvent): boolean {
    return this.channel.shouldDebounce(event);
  }

  private debounceUserMessage(event: InboundEvent, dedupeKey: string | null): void {
    this.debouncedMessages.push({ event, dedupeKey });
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flushDebouncedMessages(), this.debounceMs);
    console.error(`[daemon] message debounced event=${event.id} batch_size=${this.debouncedMessages.length}`);
  }

  private flushDebouncedMessages(): void {
    this.debounceTimer = null;
    const batch = this.debouncedMessages.splice(0);
    if (!batch.length) return;
    const event = aggregateInboundMessages(batch.map(item => item.event));
    const dedupeKeys = batch.map(item => item.dedupeKey).filter((key): key is string => !!key);
    if (this.runner.isRunning() && this.runner.capabilities.steer) {
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
    this.channel.bindInbound(event);
    await this.addReaction(event, PROCESSING_REACTION, 'processing');
    writeCurrentContext(this.config, event);
    const response = await this.runner.steer(toAgentPrompt(event, this.channel.label));
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
    this.channel.bindInbound(event);
    await this.addReaction(event, PROCESSING_REACTION, 'processing');
    writeCurrentContext(this.config, event);
    await this.refreshContextUsage(event.id);
    const prompt = toAgentPrompt(event, this.channel.label);
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
      recordContextUsage(this.config, usage, eventId);
      console.error(`[daemon] context usage event=${eventId} value=${JSON.stringify(usage.text)} source=${usage.source}`);
    } catch (error) {
      console.error(`[daemon] context usage warning event=${eventId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async addReaction(event: InboundEvent, emojiType: string, phase: string): Promise<void> {
    if (!this.channel.sender.addReaction) return;
    const messageIds = reactionMessageIds(event);
    for (const messageId of messageIds) {
      try {
        await this.channel.sender.addReaction(messageId, emojiType);
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
    if (this.stopped || this.callbackDeliveryScheduled) return;
    if (!this.callbacksRecovered) {
      recoverParentNotifications(this.config);
      this.callbacksRecovered = true;
    }
    this.callbackDeliveryScheduled = true;
    const task = this.queue.then(async () => {
      while (!this.stopped) {
        // Claim only when main is ready, so a waiting backlog consumes no retry attempts.
        const [notice] = claimParentNotifications(this.config, 1);
        if (!notice) break;
        try {
          await this.handleEvent(noticeToInbound(notice));
          acknowledgeParentNotification(this.config, notice.id);
        } catch (error) {
          try { releaseParentNotification(this.config, notice.id); }
          catch (releaseError) { console.error(`[session-callback] release failed: ${releaseError}`); }
          console.error(`[daemon] ${error instanceof Error ? error.stack || error.message : error}`);
        }
      }
    });
    this.queue = task.catch(error => console.error(`[session-callback] ${error}`))
      .finally(() => { this.callbackDeliveryScheduled = false; });
  }

  private dedupeKey(event: InboundEvent): string | null {
    return this.channel.dedupeKey(event);
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
    this.stopped = true;
    this.scheduler.stop();
    this.runtimeCron.stop();
    if (this.callbackPoller) clearInterval(this.callbackPoller);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debouncedMessages = [];
    this.channel.close();
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
    `Aggregated ${events.length} inbound messages in receive order.`,
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
