import { normalizeInbound } from '../events.js';
import { nextCronDate, parseCronExpression } from './utils.js';
import type { AppConfig, InboundEvent, SchedulerConfig, WakeupConfig } from '../../types.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface WakeupSchedulerOptions {
  now?: () => number;
  setTimeout?: (callback: () => void, delay: number) => NodeJS.Timeout;
  clearTimeout?: (timer: NodeJS.Timeout) => void;
}

export class WakeupScheduler {
  private config: SchedulerConfig;
  private onEvent: (event: InboundEvent) => Promise<void>;
  private timers = new Set<NodeJS.Timeout>();
  private active = false;
  private generation = 0;
  private now: () => number;
  private setTimer: NonNullable<WakeupSchedulerOptions['setTimeout']>;
  private clearTimer: NonNullable<WakeupSchedulerOptions['clearTimeout']>;

  constructor(config: AppConfig, onEvent: (event: InboundEvent) => Promise<void>, options: WakeupSchedulerOptions = {}) {
    this.config = config.scheduler;
    this.onEvent = onEvent;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimeout ?? setTimeout;
    this.clearTimer = options.clearTimeout ?? clearTimeout;
  }

  start(): void {
    if (!this.config.enabled || this.active) return;
    this.active = true;
    const generation = ++this.generation;
    for (const wakeup of this.config.wakeups || []) {
      this.schedule(wakeup, generation);
    }
  }

  stop(): void {
    this.active = false;
    this.generation++;
    for (const timer of this.timers) this.clearTimer(timer);
    this.timers.clear();
  }

  private schedule(wakeup: WakeupConfig, generation: number): void {
    if (!this.active || generation !== this.generation) return;
    const now = this.now();
    const delay = nextDelayMs(wakeup, new Date(now));
    if (delay == null) {
      console.error(`[scheduler] unsupported wakeup ${wakeup.id || 'unnamed'}; use intervalMs or cron fields with *, */n, numbers, and comma lists`);
      return;
    }
    console.error(`[scheduler] scheduled ${wakeup.id || 'wake'} in ${Math.round(delay / 1000)}s`);
    this.waitUntil(wakeup, now + delay, generation);
  }

  private waitUntil(wakeup: WakeupConfig, dueAt: number, generation: number): void {
    if (!this.active || generation !== this.generation) return;
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(1, dueAt - this.now()));
    const timer = this.setTimer(() => {
      this.timers.delete(timer);
      if (!this.active || generation !== this.generation) return;
      if (this.now() < dueAt) {
        this.waitUntil(wakeup, dueAt, generation);
        return;
      }
      this.fire(wakeup, generation).catch(error => console.error(`[scheduler] wakeup failed: ${error instanceof Error ? error.message : String(error)}`));
    }, delay);
    this.timers.add(timer);
  }

  private async fire(wakeup: WakeupConfig, generation: number): Promise<void> {
    try {
      await this.onEvent(normalizeInbound({ type: 'wake', ...wakeup }, 'scheduler'));
    } finally {
      this.schedule(wakeup, generation);
    }
  }
}

export function nextDelayMs(wakeup: WakeupConfig, now = new Date()): number | null {
  if (Number.isFinite(wakeup.intervalMs) && (wakeup.intervalMs as number) > 0) return wakeup.intervalMs as number;
  if (!wakeup.cron) return null;
  const next = nextCronDate(wakeup.cron, now);
  return next ? Math.max(1000, next.getTime() - now.getTime()) : null;
}

export { nextCronDate, parseCronExpression };
