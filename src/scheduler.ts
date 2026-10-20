import { normalizeInbound } from './events.js';
import { nextCronDate, parseCronExpression } from './cron-utils.js';
import type { AppConfig, InboundEvent, SchedulerConfig, WakeupConfig } from './types.js';

export class WakeupScheduler {
  private config: SchedulerConfig;
  private onEvent: (event: InboundEvent) => Promise<void>;
  private timers: NodeJS.Timeout[] = [];
  private active = false;

  constructor(config: AppConfig, onEvent: (event: InboundEvent) => Promise<void>) {
    this.config = config.scheduler;
    this.onEvent = onEvent;
  }

  start(): void {
    if (!this.config.enabled) return;
    this.active = true;
    for (const wakeup of this.config.wakeups || []) {
      this.schedule(wakeup);
    }
  }

  stop(): void {
    this.active = false;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  private schedule(wakeup: WakeupConfig): void {
    if (!this.active) return;
    const delay = nextDelayMs(wakeup);
    if (delay == null) {
      console.error(`[scheduler] unsupported wakeup ${wakeup.id || 'unnamed'}; use intervalMs or cron fields with *, */n, numbers, and comma lists`);
      return;
    }
    console.error(`[scheduler] scheduled ${wakeup.id || 'wake'} in ${Math.round(delay / 1000)}s`);
    const timer = setTimeout(async () => {
      this.timers = this.timers.filter(item => item !== timer);
      try {
        await this.onEvent(normalizeInbound({ type: 'wake', ...wakeup }, 'scheduler'));
      } finally {
        if (this.active) this.schedule(wakeup);
      }
    }, delay);
    this.timers.push(timer);
  }
}

export function nextDelayMs(wakeup: WakeupConfig, now = new Date()): number | null {
  if (Number.isFinite(wakeup.intervalMs) && (wakeup.intervalMs as number) > 0) return wakeup.intervalMs as number;
  if (!wakeup.cron) return null;
  const next = nextCronDate(wakeup.cron, now);
  return next ? Math.max(1000, next.getTime() - now.getTime()) : null;
}

export { nextCronDate, parseCronExpression };
