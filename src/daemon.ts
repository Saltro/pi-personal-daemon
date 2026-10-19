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
    this.queue = this.queue.then(() => this.handleEvent(event)).catch(error => {
      if (dedupeKey) this.seenInbound.delete(dedupeKey);
      console.error(`[daemon] ${error.stack || error}`);
    });
    return this.queue;
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
    if (!event.messageId || !this.sender.addReaction) return;
    try {
      await this.sender.addReaction(event.messageId, emojiType);
      console.error(`[daemon] reaction ok event=${event.id} message=${event.messageId} emoji=${emojiType} phase=${phase}`);
    } catch (error) {
      console.error(`[daemon] reaction warning event=${event.id} message=${event.messageId} emoji=${emojiType} phase=${phase}: ${error instanceof Error ? error.message : String(error)}`);
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
    this.feishuWs?.close({ force: true });
    this.httpServer?.close();
    this.stdinReceiver?.close();
    this.runner.close();
  }
}
