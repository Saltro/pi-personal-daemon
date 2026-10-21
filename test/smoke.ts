import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import '../src/extensions/index.js';
import { PersonalDaemon } from '../src/core/daemon/daemon.js';
import { createMainAgentRunner } from '../src/core/agents/registry.js';
import { normalizeInbound } from '../src/core/events.js';
import { loadCronRegistry, saveCronRegistry } from '../src/core/cron/registry.js';
import { readFeishuChatBinding } from '../src/core/state/binding.js';
import { readCurrentContext } from '../src/core/state/context.js';
import { loadRegistry } from '../src/core/sessions/registry.js';
import { listParentNotifications } from '../src/core/sessions/callbacks.js';
import { extractContextUsage } from '../src/extensions/pi/runner.js';
import { RuntimeCronDispatcher } from '../src/core/cron/dispatch.js';
import { nextCronDate, nextDelayMs, WakeupScheduler } from '../src/core/cron/scheduler.js';
import { isValidFeishuToken } from '../src/extensions/feishu/webhook.js';
import { normalizeFeishuInbound } from '../src/extensions/feishu/normalize.js';
import type { AppConfig } from '../src/types.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-personal-daemon-'));
const repoRoot = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(repoRoot, 'dist/index.js');
const outbox = path.join(tmp, 'outbox.jsonl');
const config: AppConfig = {
  agent: { sessionId: 'smoke', cwd: tmp, piBin: 'pi', extraArgs: [], mock: true },
  http: { enabled: false, host: '127.0.0.1', port: 0, path: '/webhook' },
  stdin: { enabled: false },
  sender: { type: 'mock', mockOutbox: outbox },
  feishu: { appId: '', appSecret: '', verificationToken: 'verify-token', encryptKey: '', baseUrl: 'https://open.feishu.cn', eventMode: 'webhook' },
  scheduler: { enabled: false, wakeups: [] },
  runtime: { contextFile: path.join(tmp, 'context.json'), stateDir: path.join(tmp, 'state') },
};
const configPath = writeConfig('config.json', config);

const v2 = feishuMessage('evt-v2', 'om-test', 'hello v2');
assert.equal(v2.id, 'evt-v2');
assert.equal(v2.chatId, 'oc-test');
assert.equal(v2.messageId, 'om-test');
assert.equal(v2.userId, 'ou-test');
assert.equal(v2.text, 'hello v2');
assert.equal(isValidFeishuToken({ header: { token: 'verify-token' } }, 'verify-token'), true);
assert.equal(isValidFeishuToken({ header: { token: 'bad' } }, 'verify-token'), false);
assert.deepEqual(
  extractContextUsage({ messageCount: 2, pendingMessageCount: 0, model: { maxTokens: 16384, contextWindow: 1000000 } }, { messages: [] }, 'smoke'),
  { text: 'Context usage unavailable', source: 'pi-rpc context usage unavailable' },
);
assert.deepEqual(
  extractContextUsage({ model: { contextWindow: 1000000 } }, { messages: [{ role: 'assistant', usage: { input: 60000, cacheRead: 2000, output: 100 } }] }, 'smoke'),
  { text: 'Context 6%', source: 'pi-rpc get_messages latest assistant usage and model contextWindow' },
);
assert.deepEqual(
  extractContextUsage({ context: { usedContextTokens: 60234, contextLimit: 163840 } }, { messages: [] }, 'smoke'),
  { text: 'Context 37%', source: 'pi-rpc get_state context/token usage fields' },
);
assert.equal(localStamp(nextCronDate('0 * * * *', new Date(2026, 9, 20, 11, 23, 45))), '2026-10-20 12:00');
assert.equal(localStamp(nextCronDate('*/15 9,10 * * *', new Date(2026, 9, 20, 9, 14, 0))), '2026-10-20 09:15');
assert.equal(localStamp(nextCronDate('30 8 1 * *', new Date(2026, 9, 2))), '2026-11-01 08:30');
assert.equal(localStamp(nextCronDate('0 9 * * 1', new Date(2026, 9, 20, 9, 1))), '2026-10-26 09:00');
assert.equal(localStamp(nextCronDate('0 9 1 * 1', new Date(2026, 9, 2))), '2026-10-05 09:00');
assert.equal(nextCronDate('0 0 * 13 *'), null);
assert.equal(nextCronDate('0-10 * * * *'), null);
assert.equal(nextDelayMs({ intervalMs: 25, prompt: 'tick' }), 25);
const scheduledEvents: string[] = [];
const scheduler = new WakeupScheduler({ ...config, scheduler: { enabled: true, wakeups: [{ id: 'quick', intervalMs: 20, prompt: 'scheduled smoke wake' }] } }, async event => {
  scheduledEvents.push(`${event.kind}:${event.source}:${event.text}`);
  scheduler.stop();
});
scheduler.start();
await until(() => scheduledEvents.length === 1);
assert.deepEqual(scheduledEvents, ['wake:scheduler:scheduled smoke wake']);

const daemon = new PersonalDaemon(config, { debounceMs: 20 });
await daemon.enqueue(normalizeInbound({ type: 'message', id: 'evt-smoke', chatId: 'chat-smoke', text: 'hello smoke' }, 'test'));
assert.equal(fs.existsSync(outbox), false);
await daemon.enqueue(v2);
await until(() => jsonl(outbox).length === 2);
await daemon.enqueue(v2);
assert.equal(jsonl(outbox).length, 2);
assert.deepEqual(jsonl(outbox).map(record => [record.messageId, record.emojiType]), [['om-test', 'OK'], ['om-test', 'DONE']]);
const context = readCurrentContext(config);
assert.equal(context.chatId, 'oc-test');
assert.equal(context.eventId, 'evt-v2');
assert.equal(context.sendCount, 0);
assert.equal(context.contextUsage, 'Context usage unavailable');
assert.equal(readFeishuChatBinding(config)?.chatId, 'oc-test');
assert.equal(fs.existsSync(path.join(config.runtime.stateDir!, 'state.sqlite')), true);
assert.equal(fs.existsSync(config.runtime.contextFile!), false);
assert.equal(fs.existsSync(path.join(config.runtime.stateDir!, 'feishu-chat-binding.json')), false);

const steerConfig: AppConfig = {
  ...config,
  sender: { type: 'mock', mockOutbox: path.join(tmp, 'steer-outbox.jsonl') },
  runtime: { stateDir: path.join(tmp, 'steer-state') },
};
let running = false;
let resolveFirst: (() => void) | undefined;
const steers: string[] = [];
const steerRunner = createMainAgentRunner(steerConfig);
Object.assign(steerRunner, {
  isRunning: () => running,
  promptAndWait: async () => {
    running = true;
    await new Promise<void>(resolve => { resolveFirst = resolve; });
    running = false;
    return '';
  },
  steer: async (message: string) => { steers.push(message); return { disposition: 'queued' as const }; },
  waitForSettled: async () => { await until(() => !running); },
  getContextUsage: async () => ({ text: 'Context usage unavailable', source: 'test' }),
});
const steerDaemon = new PersonalDaemon(steerConfig, { runner: steerRunner, debounceMs: 20 });
await steerDaemon.enqueue(feishuMessage('evt-active-1', 'om-active-1', 'first active'));
await until(() => running);
void steerDaemon.enqueue(feishuMessage('evt-active-2', 'om-active-2', 'second active'));
void steerDaemon.enqueue(feishuMessage('evt-active-3', 'om-active-3', 'third active'));
await until(() => steers.length === 1);
assert.match(steers[0], /Aggregated 2 inbound messages/);
assert.match(steers[0], /second active/);
assert.match(steers[0], /third active/);
assert.equal(running, true);
resolveFirst?.();
await until(() => jsonl(steerConfig.sender.mockOutbox).length === 6);
for (const messageId of ['om-active-2', 'om-active-3']) {
  const reactions = jsonl(steerConfig.sender.mockOutbox);
  assert.ok(reactions.some(record => record.messageId === messageId && record.emojiType === 'OK'));
  assert.ok(reactions.some(record => record.messageId === messageId && record.emojiType === 'DONE'));
}
assert.equal(JSON.parse(cli(['bind', 'status']).stdout).binding.chatId, 'oc-test');

await daemon.enqueue({ id: 'return-callback-smoke', source: 'session-callback', kind: 'wake', chatId: 'personal-agent-tryout', text: 'Child session completed.' });
assert.equal(readCurrentContext(config).eventId, 'return-callback-smoke');
assert.equal(readFeishuChatBinding(config)?.chatId, 'oc-test');
cli(['send', '--stdin'], configPath, {}, '**hello** from `pi-personal-daemon send`\n- list item with `inline code`');
const sent = jsonl(outbox)[2];
assert.equal(sent.chatId, 'oc-test');
assert.equal(sent.inReplyTo, 'return-callback-smoke');
assert.equal(sent.contextFooter, 'Context usage unavailable');
assert.equal(sent.msgType, 'interactive');
assert.equal(sent.card.schema, '2.0');
assert.equal(sent.card.config.width_mode, 'fill');
assert.equal(sent.card.body.elements[0].content, '**hello** from `pi-personal-daemon send`\n- list item with `inline code`');
assert.match(sent.card.body.elements[2].content, /<font color="grey"><font size="small">Context usage unavailable/);
assert.equal(readCurrentContext(config).sendCount, 1);

const noParent = JSON.parse(cli(['sessions', 'create', '--id', 'no-parent']).stdout);
assert.equal(noParent.autoReturn, false);
const created = JSON.parse(cli(['sessions', 'create', '--id', 's1', '--name', 'smoke session', '--prompt', 'first prompt', '--wait'], configPath, { PI_SESSION_ID: 'smoke-parent' }).stdout);
assert.equal(created.status, 'completed');
assert.equal(created.autoReturn, true);
assert.ok(created.parentCallback);
assert.ok(created.parentNotificationPath);
assert.match(created.lastResult, /first prompt/);
assert.equal(listParentNotifications(config).length, 1);
await daemon.enqueue(normalizeInbound({ type: 'message', id: 'evt-drain-callbacks', chatId: 'chat-drain-callbacks', text: 'drain callbacks' }, 'test'));
assert.equal(listParentNotifications(config).length, 0);
const continued = JSON.parse(cli(['sessions', 'send', 's1', '--message', 'second prompt', '--wait']).stdout);
assert.equal(continued.status, 'completed');
assert.match(continued.lastResult, /second prompt/);
assert.match(cli(['sessions', 'list']).stdout, /^s1\tcompleted\ttrue/m);
assert.equal(JSON.parse(cli(['sessions', 'status', 's1']).stdout).id, 's1');
assert.match(cli(['sessions', 'history', 's1', '--lines', '20']).stdout, /first prompt[\s\S]*second prompt/);

const fakePi = path.join(tmp, 'fake-pi.cjs');
fs.writeFileSync(fakePi, `#!/usr/bin/env node\nconst prompt = process.argv[process.argv.length - 1];\nsetTimeout(() => console.log('fake pi done: ' + prompt), 500);\n`);
fs.chmodSync(fakePi, 0o755);
const asyncConfig: AppConfig = { ...config, agent: { ...config.agent, mock: false, piBin: fakePi }, runtime: { stateDir: path.join(tmp, 'async-state') } };
const asyncConfigPath = writeConfig('config-async.json', asyncConfig);
const launched = JSON.parse(cli(['sessions', 'create', '--id', 'async1', '--prompt', 'async prompt', '--no-return'], asyncConfigPath, {}, undefined, tmp).stdout);
assert.equal(launched.status, 'running');
await until(() => JSON.parse(cli(['sessions', 'status', 'async1'], asyncConfigPath).stdout).status !== 'running');
const asyncStatus = JSON.parse(cli(['sessions', 'status', 'async1'], asyncConfigPath).stdout);
assert.equal(asyncStatus.status, 'completed');
assert.equal(asyncStatus.pid, undefined);
assert.match(asyncStatus.lastResult, /fake pi done: async prompt/);

cli(['cron', 'create', '--id', 'c1', '--prompt', 'cron prompt', '--cron', '0 * * * *', '--target', 'main']);
assert.equal(loadCronRegistry(config).crons.c1.prompt, 'cron prompt');
assert.match(cli(['cron', 'list']).stdout, /^c1\tscheduled\ttrue\tmain/m);
const updatedCron = JSON.parse(cli(['cron', 'update', 'c1', '--prompt', 'updated cron prompt', '--at', new Date(Date.now() + 60000).toISOString(), '--target', 'new', '--disabled']).stdout);
assert.equal(updatedCron.enabled, false);
assert.equal(updatedCron.target, 'new');
assert.equal(updatedCron.schedule.type, 'at');
cli(['cron', 'disable', 'c1']);
assert.equal(JSON.parse(cli(['cron', 'status', 'c1']).stdout).status, 'disabled');
cli(['cron', 'delete', 'c1']);
assert.equal(loadCronRegistry(config).crons.c1, undefined);

const cronConfig: AppConfig = { ...config, runtime: { stateDir: path.join(tmp, 'cron-state') } };
const cronConfigPath = writeConfig('config-cron.json', cronConfig);
const dueAt = new Date(Date.now() - 1000).toISOString();
cli(['cron', 'create', '--id', 'once-main', '--prompt', 'one shot main', '--at', dueAt, '--target', 'main'], cronConfigPath);
const runtimeEvents: string[] = [];
const onceDispatcher = new RuntimeCronDispatcher(cronConfig, async event => { runtimeEvents.push(`${event.kind}:${event.source}:${event.text}`); });
onceDispatcher.start();
await until(() => loadCronRegistry(cronConfig).crons['once-main'].status === 'completed');
onceDispatcher.stop();
assert.deepEqual(runtimeEvents, ['wake:runtime-cron:one shot main']);
assert.equal(loadCronRegistry(cronConfig).crons['once-main'].enabled, false);
cli(['cron', 'create', '--id', 'recurring-overdue', '--prompt', 'recurring overdue main', '--cron', '* * * * *', '--target', 'main'], cronConfigPath);
const registry = loadCronRegistry(cronConfig);
registry.crons['recurring-overdue'].nextRunAt = dueAt;
saveCronRegistry(cronConfig, registry);
const recurringEvents: string[] = [];
const recurringDispatcher = new RuntimeCronDispatcher(cronConfig, async event => { recurringEvents.push(event.text); });
recurringDispatcher.start();
await until(() => {
  const record = loadCronRegistry(cronConfig).crons['recurring-overdue'];
  return !!record.lastFiredAt && record.status === 'scheduled';
});
recurringDispatcher.stop();
assert.deepEqual(recurringEvents, ['recurring overdue main']);
assert.equal(loadCronRegistry(cronConfig).crons['recurring-overdue'].status, 'scheduled');
assert.ok(Date.parse(loadCronRegistry(cronConfig).crons['recurring-overdue'].nextRunAt!) > Date.now());

const targetConfig: AppConfig = { ...config, runtime: { stateDir: path.join(tmp, 'target-state') } };
const targetPath = writeConfig('config-target.json', targetConfig);
cli(['sessions', 'create', '--id', 'target-s1', '--no-return'], targetPath);
for (const [id, target, prompt] of [
  ['once-new', 'new', 'new target prompt'],
  ['once-session', 'session:target-s1', 'session target prompt'],
  ['fixed-a', 'session:fixed-child', 'fixed child prompt a'],
  ['fixed-b', 'session:fixed-child', 'fixed child prompt b'],
] as const) cli(['cron', 'create', '--id', id, '--prompt', prompt, '--at', dueAt, '--target', target], targetPath);
const alias = JSON.parse(cli(['cron', 'create', '--id', 'fixed-alias', '--prompt', 'fixed alias prompt', '--at', dueAt, '--target-session', 'fixed-alias-child'], targetPath).stdout);
assert.equal(alias.target, 'session:fixed-alias-child');
const targetDispatcher = new RuntimeCronDispatcher(targetConfig, async () => undefined);
targetDispatcher.start();
await until(() => Object.values(loadCronRegistry(targetConfig).crons).every(record => record.status === 'completed'));
targetDispatcher.stop();
const targetSessions = loadRegistry(targetConfig).sessions;
assert.equal(Object.values(targetSessions).filter(session => session.lastPrompt === 'new target prompt').length, 1);
assert.equal(targetSessions['target-s1'].lastPrompt, 'session target prompt');
assert.equal(targetSessions['fixed-child'].lastPrompt, 'fixed child prompt b');
for (const session of Object.values(targetSessions)) assert.equal(session.autoReturn, false);
assert.ok(targetSessions['fixed-child'].parentCallback);
const fixedLog = fs.readFileSync(targetSessions['fixed-child'].logPath, 'utf8');
assert.match(fixedLog, /fixed child prompt a/);
assert.match(fixedLog, /fixed child prompt b/);
assert.equal(listParentNotifications(targetConfig).length, 0);
cli(['return', '--stdin'], targetPath, {
  PI_PERSONAL_SESSION_ID: 'fixed-child',
  PI_PERSONAL_PARENT_CALLBACK: JSON.stringify(targetSessions['fixed-child'].parentCallback),
}, 'explicit cron child return');
const notices = listParentNotifications(targetConfig);
assert.equal(notices.length, 1);
assert.equal(notices[0].type, 'session.return');
const explicitReturnEvents: string[] = [];
const returnRunner = createMainAgentRunner(targetConfig);
Object.assign(returnRunner, { promptAndWait: async (message: string) => { explicitReturnEvents.push(message); return ''; } });
const returnDaemon = new PersonalDaemon(targetConfig, { runner: returnRunner });
await returnDaemon.enqueue(normalizeInbound({ type: 'message', id: 'evt-return-drain', chatId: 'chat-return-drain', text: 'drain explicit return' }, 'test'));
assert.equal(listParentNotifications(targetConfig).length, 0);
assert.ok(explicitReturnEvents.some(message => message.includes('explicit cron child return')));
assert.ok(explicitReturnEvents.some(message => message.includes('fixed-child')));
returnDaemon.stop();
daemon.stop();
steerDaemon.stop();
console.log('smoke ok', outbox);

function feishuMessage(id: string, messageId: string, text: string) {
  return normalizeFeishuInbound({
    schema: '2.0', header: { event_id: id, event_type: 'im.message.receive_v1' },
    event: { sender: { sender_id: { open_id: 'ou-test' } }, message: { message_id: messageId, chat_id: 'oc-test', message_type: 'text', content: JSON.stringify({ text }) } },
  }, 'test-feishu');
}

function cli(args: string[], file = configPath, env: NodeJS.ProcessEnv = {}, input?: string, cwd = repoRoot) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, PERSONAL_DAEMON_CONFIG: file };
  for (const key of ['PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_PERSONAL_SESSION_ID', 'PI_PERSONAL_PARENT_CALLBACK']) delete childEnv[key];
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd, env: { ...childEnv, ...env }, input, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr || result.error}`);
  return result;
}

function writeConfig(name: string, value: AppConfig): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function jsonl(file: string): any[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for smoke state');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function localStamp(date: Date | null | undefined): string | undefined {
  if (!date) return undefined;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
