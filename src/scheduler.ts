import { normalizeInbound } from './events.js';
import type { AppConfig, InboundEvent, SchedulerConfig, WakeupConfig } from './types.js';

export class WakeupScheduler {
  private config: SchedulerConfig;
  private onEvent: (event: InboundEvent) => Promise<void>;
  private timers: NodeJS.Timeout[] = [];

  constructor(config: AppConfig, onEvent: (event: InboundEvent) => Promise<void>) {
    this.config = config.scheduler;
    this.onEvent = onEvent;
  }

  start(): void {
    if (!this.config.enabled) return;
    for (const wakeup of this.config.wakeups || []) {
      const delay = nextDelayMs(wakeup);
      if (delay == null) {
        console.error(`[scheduler] unsupported wakeup ${wakeup.id || 'unnamed'}; use intervalMs or simple cron like "0 * * * *"`);
        continue;
      }
      const scheduleOnce = () => {
        const timer = setTimeout(async () => {
          await this.onEvent(normalizeInbound({ type: 'wake', ...wakeup }, 'scheduler'));
          scheduleOnce();
        }, nextDelayMs(wakeup) ?? delay);
        this.timers.push(timer);
      };
      console.error(`[scheduler] scheduled ${wakeup.id || 'wake'} in ${Math.round(delay / 1000)}s`);
      const timer = setTimeout(async () => {
        await this.onEvent(normalizeInbound({ type: 'wake', ...wakeup }, 'scheduler'));
        scheduleOnce();
      }, delay);
      this.timers.push(timer);
    }
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }
}

function nextDelayMs(wakeup: WakeupConfig): number | null {
  if (Number.isFinite(wakeup.intervalMs)) return wakeup.intervalMs as number;
  if (!wakeup.cron) return null;
  const parts = wakeup.cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour] = parts;
  const now = new Date();
  for (let i = 1; i <= 24 * 60; i++) {
    const candidate = new Date(now.getTime() + i * 60 * 1000);
    if (matches(minute, candidate.getMinutes()) && matches(hour, candidate.getHours())) {
      candidate.setSeconds(0, 0);
      return Math.max(1000, candidate.getTime() - now.getTime());
    }
  }
  return null;
}

function matches(expr: string, value: number): boolean {
  if (expr === '*') return true;
  if (expr.startsWith('*/')) return value % Number(expr.slice(2)) === 0;
  return Number(expr) === value;
}
