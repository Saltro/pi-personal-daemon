import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextCronDate, nextDelayMs, WakeupScheduler } from '../src/core/cron/scheduler.js';
import type { WakeupSchedulerOptions } from '../src/core/cron/scheduler.js';
import type { AppConfig, InboundEvent, WakeupConfig } from '../src/types.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

class FakeClock {
  private nextId = 1;
  timers = new Map<NodeJS.Timeout, { callback: () => void; delay: number }>();
  cleared: NodeJS.Timeout[] = [];
  delays: number[] = [];

  constructor(public time: number) {}

  options(): WakeupSchedulerOptions {
    return {
      now: () => this.time,
      setTimeout: (callback, delay) => {
        const timer = { id: this.nextId++ } as unknown as NodeJS.Timeout;
        this.timers.set(timer, { callback, delay });
        this.delays.push(delay);
        assert.ok(delay >= 1 && delay <= MAX_TIMER_DELAY_MS, `unsafe Node timer delay: ${delay}`);
        return timer;
      },
      clearTimeout: timer => {
        this.cleared.push(timer);
        this.timers.delete(timer);
      },
    };
  }

  fireNext(elapsed?: number): void {
    const next = this.timers.entries().next().value;
    assert.ok(next, 'expected a scheduled timer');
    const [timer, task] = next;
    this.timers.delete(timer);
    this.time += elapsed ?? task.delay;
    task.callback();
  }

  nextDelay(): number {
    const task = this.timers.values().next().value;
    assert.ok(task, 'expected a scheduled timer');
    return task.delay;
  }
}

function config(wakeups: WakeupConfig[], enabled = true): AppConfig {
  return {
    agent: { sessionId: 'scheduler-test', cwd: process.cwd(), piBin: 'pi', extraArgs: [], mock: true },
    http: { enabled: false, host: '127.0.0.1', port: 0, path: '/webhook' },
    stdin: { enabled: false },
    sender: { type: 'mock', mockOutbox: '' },
    feishu: { appId: '', appSecret: '', verificationToken: '', encryptKey: '', baseUrl: '', eventMode: 'webhook' },
    scheduler: { enabled, wakeups },
    runtime: {},
  };
}

await test('long interval waits in bounded chunks and never fires before its actual timestamp', async () => {
  const intervalMs = MAX_TIMER_DELAY_MS + 5000;
  const clock = new FakeClock(0);
  const events: InboundEvent[] = [];
  const scheduler = new WakeupScheduler(config([{ id: 'long', intervalMs, prompt: 'long interval' }]), async event => {
    events.push(event);
  }, clock.options());
  scheduler.start();
  scheduler.start();
  assert.equal(clock.timers.size, 1);
  assert.equal(clock.nextDelay(), MAX_TIMER_DELAY_MS);
  clock.fireNext();
  assert.equal(events.length, 0);
  assert.equal(clock.nextDelay(), 5000);
  clock.fireNext(1000);
  assert.equal(events.length, 0);
  assert.equal(clock.nextDelay(), 4000);
  clock.fireNext();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'wake');
  assert.equal(events[0].source, 'scheduler');
  assert.equal(events[0].text, 'long interval');
  await Promise.resolve();
  assert.equal(clock.nextDelay(), MAX_TIMER_DELAY_MS);
  scheduler.stop();
  assert.equal(clock.timers.size, 0);
});

await test('monthly cron survives a wait longer than Node timer range and keeps cron boundaries', async () => {
  const start = new Date(2026, 0, 2).getTime();
  const dueAt = new Date(2026, 1, 1).getTime();
  const clock = new FakeClock(start);
  const firedAt: number[] = [];
  const scheduler = new WakeupScheduler(config([{ cron: '0 0 1 * *', prompt: 'monthly' }]), async () => {
    firedAt.push(clock.time);
  }, clock.options());
  scheduler.start();
  assert.equal(clock.nextDelay(), MAX_TIMER_DELAY_MS);
  clock.fireNext();
  assert.deepEqual(firedAt, []);
  assert.equal(clock.nextDelay(), dueAt - clock.time);
  clock.fireNext();
  await Promise.resolve();
  assert.deepEqual(firedAt, [dueAt]);
  assert.equal(clock.nextDelay(), MAX_TIMER_DELAY_MS);
  const nextDueAt = new Date(2026, 2, 1).getTime();
  clock.fireNext();
  assert.deepEqual(firedAt, [dueAt]);
  assert.equal(clock.nextDelay(), nextDueAt - clock.time);
  clock.fireNext();
  await Promise.resolve();
  assert.deepEqual(firedAt, [dueAt, nextDueAt]);
  scheduler.stop();
});

await test('early timer or clock rollback rechecks the original due time', async () => {
  const clock = new FakeClock(1000);
  const firedAt: number[] = [];
  const scheduler = new WakeupScheduler(config([{ intervalMs: 100, prompt: 'tick' }]), async () => {
    firedAt.push(clock.time);
  }, clock.options());
  scheduler.start();
  clock.fireNext(-500);
  assert.deepEqual(firedAt, []);
  assert.equal(clock.nextDelay(), 600);
  clock.fireNext(599);
  assert.deepEqual(firedAt, []);
  assert.equal(clock.nextDelay(), 1);
  clock.fireNext();
  await Promise.resolve();
  assert.deepEqual(firedAt, [1100]);
  assert.equal(clock.nextDelay(), 100);
  scheduler.stop();
});

await test('interval cadence remains an interval after handler completion, without overlapping handlers', async () => {
  const clock = new FakeClock(0);
  let finish: (() => void) | undefined;
  let fires = 0;
  const scheduler = new WakeupScheduler(config([{ intervalMs: 100, prompt: 'tick' }]), async () => {
    fires++;
    await new Promise<void>(resolve => { finish = resolve; });
  }, clock.options());
  scheduler.start();
  clock.fireNext();
  assert.equal(fires, 1);
  assert.equal(clock.timers.size, 0);
  clock.time += 40;
  finish?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(clock.nextDelay(), 100);
  scheduler.stop();
});

await test('late cron fires once then schedules the next real cron boundary', async () => {
  const start = new Date(2026, 0, 2, 10, 0).getTime();
  const clock = new FakeClock(start);
  let fires = 0;
  const scheduler = new WakeupScheduler(config([{ cron: '* * * * *', prompt: 'minute' }]), async () => {
    fires++;
    clock.time += 10_000;
  }, clock.options());
  scheduler.start();
  assert.equal(clock.nextDelay(), 60_000);
  clock.fireNext(145_000);
  await Promise.resolve();
  assert.equal(fires, 1);
  assert.equal(clock.nextDelay(), 25_000);
  scheduler.stop();
});

await test('stop clears every timer and stale callbacks do not fire or reschedule', async () => {
  const clock = new FakeClock(0);
  let fires = 0;
  const scheduler = new WakeupScheduler(config([{ intervalMs: 100 }, { intervalMs: MAX_TIMER_DELAY_MS + 1 }]), async () => {
    fires++;
  }, clock.options());
  scheduler.start();
  const callbacks = [...clock.timers.values()].map(task => task.callback);
  scheduler.stop();
  assert.equal(clock.timers.size, 0);
  assert.equal(clock.cleared.length, 2);
  for (const callback of callbacks) callback();
  await Promise.resolve();
  assert.equal(fires, 0);
  assert.equal(clock.timers.size, 0);
});

await test('stop/restart does not let the old in-flight handler schedule duplicate timers', async () => {
  const clock = new FakeClock(0);
  let finish: (() => void) | undefined;
  let fires = 0;
  const scheduler = new WakeupScheduler(config([{ intervalMs: 100 }]), async () => {
    fires++;
    await new Promise<void>(resolve => { finish = resolve; });
  }, clock.options());
  scheduler.start();
  clock.fireNext();
  assert.equal(fires, 1);
  scheduler.stop();
  scheduler.start();
  assert.equal(clock.timers.size, 1);
  finish?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(clock.timers.size, 1);
  scheduler.stop();
});

await test('a rejected handler still preserves cadence without an unhandled rejection', async () => {
  const clock = new FakeClock(0);
  const scheduler = new WakeupScheduler(config([{ intervalMs: 100 }]), async () => {
    throw new Error('fake handler failure');
  }, clock.options());
  scheduler.start();
  clock.fireNext();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(clock.nextDelay(), 100);
  scheduler.stop();
});

await test('stop during a handler prevents any timer from being rearmed', async () => {
  const clock = new FakeClock(0);
  const scheduler = new WakeupScheduler(config([{ intervalMs: 10 }]), async () => scheduler.stop(), clock.options());
  scheduler.start();
  clock.fireNext();
  await Promise.resolve();
  assert.equal(clock.timers.size, 0);
});

await test('disabled and invalid schedules create no timers, and nextDelayMs keeps interval/cron semantics', () => {
  const clock = new FakeClock(0);
  const disabled = new WakeupScheduler(config([{ intervalMs: 100 }], false), async () => undefined, clock.options());
  disabled.start();
  assert.equal(clock.timers.size, 0);
  const invalid = new WakeupScheduler(config([{ cron: 'invalid' }]), async () => undefined, clock.options());
  invalid.start();
  assert.equal(clock.timers.size, 0);
  invalid.stop();
  const now = new Date(2026, 0, 2, 10, 0, 15);
  assert.equal(nextDelayMs({ intervalMs: 125, cron: '* * * * *' }, now), 125);
  assert.equal(nextDelayMs({ cron: '* * * * *' }, now), 45_000);
  assert.equal(nextCronDate('invalid', now), null);
});
