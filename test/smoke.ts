import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PersonalDaemon } from '../src/daemon.js';
import { normalizeInbound } from '../src/events.js';
import { loadCronRegistry } from '../src/cron-registry.js';
import { extractContextUsage } from '../src/pi-runner.js';
import { RuntimeCronDispatcher } from '../src/runtime-cron-dispatch.js';
import { nextCronDate, nextDelayMs, WakeupScheduler } from '../src/scheduler.js';
import { isValidFeishuToken } from '../src/receivers.js';
import type { AppConfig } from '../src/types.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-personal-daemon-'));
const outbox = path.join(tmp, 'outbox.jsonl');
const contextFile = path.join(tmp, 'context.json');
const stateDir = path.join(tmp, 'state');
const bindingFile = path.join(stateDir, 'feishu-chat-binding.json');
const configPath = path.join(tmp, 'config.json');
const config: AppConfig = {
  agent: {
    sessionId: 'smoke',
    cwd: tmp,
    piBin: 'pi',
    extraArgs: [],
    mock: true,
  },
  http: { enabled: false, host: '127.0.0.1', port: 0, path: '/webhook' },
  stdin: { enabled: false },
  sender: { type: 'mock', mockOutbox: outbox },
  feishu: { appId: '', appSecret: '', verificationToken: 'verify-token', encryptKey: '', baseUrl: 'https://open.feishu.cn', eventMode: 'webhook' },
  scheduler: { enabled: false, wakeups: [] },
  runtime: { contextFile, stateDir },
};
fs.writeFileSync(configPath, JSON.stringify(config));

const v2 = normalizeInbound({
  schema: '2.0',
  header: { event_id: 'evt-v2', event_type: 'im.message.receive_v1', token: 'verify-token' },
  event: {
    sender: { sender_id: { open_id: 'ou-test' } },
    message: {
      message_id: 'om-test',
      chat_id: 'oc-test',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello v2' }),
    },
  },
}, 'test-feishu');
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
  extractContextUsage({ model: { contextWindow: 1000000, maxTokens: 16384 } }, { messages: [{ role: 'assistant', usage: { input: 60000, cacheRead: 2000, output: 100 } }] }, 'smoke'),
  { text: 'Context 6%', source: 'pi-rpc get_messages latest assistant usage and model contextWindow' },
);
assert.deepEqual(
  extractContextUsage({ model: { contextWindow: 1000000 } }, { messages: [{ role: 'assistant', usage: { totalTokens: 60000 } }] }, 'smoke'),
  { text: 'Context usage unavailable', source: 'pi-rpc context usage unavailable' },
);
assert.deepEqual(
  extractContextUsage({ context: { usedContextTokens: 60234, contextLimit: 163840 } }, { messages: [] }, 'smoke'),
  { text: 'Context 37%', source: 'pi-rpc get_state context/token usage fields' },
);
assert.equal(localStamp(nextCronDate('0 * * * *', new Date(2026, 9, 20, 11, 23, 45))), '2026-10-20 12:00');
assert.equal(localStamp(nextCronDate('*/15 9,10 * * *', new Date(2026, 9, 20, 9, 14, 0))), '2026-10-20 09:15');
assert.equal(localStamp(nextCronDate('30 8 1 * *', new Date(2026, 9, 2, 0, 0, 0))), '2026-11-01 08:30');
assert.equal(localStamp(nextCronDate('0 9 * * 1', new Date(2026, 9, 20, 9, 1, 0))), '2026-10-26 09:00');
assert.equal(localStamp(nextCronDate('0 9 1 * 1', new Date(2026, 9, 2, 0, 0, 0))), '2026-10-05 09:00');
assert.equal(nextCronDate('0 0 * 13 *'), null);
assert.equal(nextCronDate('0-10 * * * *'), null);
assert.equal(nextDelayMs({ intervalMs: 25, prompt: 'tick' }), 25);
const scheduledEvents: string[] = [];
const testScheduler = new WakeupScheduler({ ...config, scheduler: { enabled: true, wakeups: [{ id: 'quick', intervalMs: 20, prompt: 'scheduled smoke wake' }] } }, async event => {
  scheduledEvents.push(`${event.kind}:${event.source}:${event.text}`);
});
testScheduler.start();
await new Promise(resolve => setTimeout(resolve, 35));
testScheduler.stop();
assert.deepEqual(scheduledEvents, ['wake:scheduler:scheduled smoke wake']);

const daemon = new PersonalDaemon(config);
await daemon.enqueue(normalizeInbound({ type: 'message', id: 'evt-smoke', chatId: 'chat-smoke', text: 'hello smoke' }, 'test'));
assert.equal(fs.existsSync(outbox), false);
await daemon.enqueue(v2);
await new Promise(resolve => setTimeout(resolve, 10_100));
await daemon.enqueue(v2);
let lines = fs.readFileSync(outbox, 'utf8').trim().split('\n');
assert.equal(lines.length, 2);
const startReaction = JSON.parse(lines[0]) as { messageId: string; emojiType: string; transport: string };
assert.equal(startReaction.messageId, 'om-test');
assert.equal(startReaction.emojiType, 'OK');
assert.equal(startReaction.transport, 'mock-reaction');
const completionReaction = JSON.parse(lines[1]) as { messageId: string; emojiType: string; transport: string };
assert.equal(completionReaction.messageId, 'om-test');
assert.equal(completionReaction.emojiType, 'DONE');
assert.equal(completionReaction.transport, 'mock-reaction');
const currentContext = JSON.parse(fs.readFileSync(contextFile, 'utf8')) as { chatId: string; eventId: string; sendCount: number; contextUsage: string; contextUsageSource: string };
assert.equal(currentContext.chatId, 'oc-test');
assert.equal(currentContext.eventId, 'evt-v2');
assert.equal(currentContext.sendCount, 0);
assert.equal(currentContext.contextUsage, 'Context usage unavailable');
assert.equal(currentContext.contextUsageSource, 'pi-rpc context usage unavailable');
assert.doesNotMatch(currentContext.contextUsage, /\b\d+\/\d+ tokens\b/);
assert.doesNotMatch(currentContext.contextUsage, /\b(messages|pending|model|Pi session)\b/);
assert.equal(JSON.parse(fs.readFileSync(bindingFile, 'utf8')).chatId, 'oc-test');

const steerOutbox = path.join(tmp, 'steer-outbox.jsonl');
const steerContextFile = path.join(tmp, 'steer-context.json');
const steerConfig: AppConfig = {
  ...config,
  sender: { type: 'mock', mockOutbox: steerOutbox },
  runtime: { contextFile: steerContextFile, stateDir: path.join(tmp, 'steer-state') },
};
const steerDaemon = new PersonalDaemon(steerConfig);
let running = false;
let resolveFirst: (() => void) | undefined;
const steers: string[] = [];
Object.assign(steerDaemon['runner'], {
  isRunning: () => running,
  promptAndWait: async () => {
    running = true;
    await new Promise<void>(resolve => { resolveFirst = resolve; });
    running = false;
    return '';
  },
  steer: async (message: string) => {
    steers.push(message);
    return { disposition: 'queued' as const };
  },
  waitForSettled: async () => {
    while (running) await new Promise(resolve => setTimeout(resolve, 5));
  },
  getContextUsage: async () => ({ text: 'Context usage unavailable', source: 'test' }),
});
const firstActive = normalizeInbound({
  schema: '2.0',
  header: { event_id: 'evt-active-1', event_type: 'im.message.receive_v1', token: 'verify-token' },
  event: {
    sender: { sender_id: { open_id: 'ou-active' } },
    message: { message_id: 'om-active-1', chat_id: 'oc-active', message_type: 'text', content: JSON.stringify({ text: 'first active' }) },
  },
}, 'test-feishu');
const secondActive = normalizeInbound({
  schema: '2.0',
  header: { event_id: 'evt-active-2', event_type: 'im.message.receive_v1', token: 'verify-token' },
  event: {
    sender: { sender_id: { open_id: 'ou-active' } },
    message: { message_id: 'om-active-2', chat_id: 'oc-active', message_type: 'text', content: JSON.stringify({ text: 'second active' }) },
  },
}, 'test-feishu');
const thirdActive = normalizeInbound({
  schema: '2.0',
  header: { event_id: 'evt-active-3', event_type: 'im.message.receive_v1', token: 'verify-token' },
  event: {
    sender: { sender_id: { open_id: 'ou-active' } },
    message: { message_id: 'om-active-3', chat_id: 'oc-active', message_type: 'text', content: JSON.stringify({ text: 'third active' }) },
  },
}, 'test-feishu');
steerDaemon.enqueue(firstActive);
await new Promise(resolve => setTimeout(resolve, 10_100));
assert.equal(running, true);
steerDaemon.enqueue(secondActive);
steerDaemon.enqueue(thirdActive);
await new Promise(resolve => setTimeout(resolve, 10_100));
assert.equal(steers.length, 1);
assert.match(steers[0], /Aggregated 2 Feishu inbound messages/);
assert.match(steers[0], /event_id=evt-active-2/);
assert.match(steers[0], /second active/);
assert.match(steers[0], /event_id=evt-active-3/);
assert.match(steers[0], /third active/);
assert.equal(running, true);
resolveFirst?.();
lines = await waitForJsonlLines(steerOutbox, 6);
assert.equal(lines.length, 6);
const steerReactions = lines.map(line => JSON.parse(line) as { messageId: string; emojiType: string });
for (const messageId of ['om-active-2', 'om-active-3']) {
  assert.ok(steerReactions.some(reaction => reaction.messageId === messageId && reaction.emojiType === 'OK'));
  assert.ok(steerReactions.some(reaction => reaction.messageId === messageId && reaction.emojiType === 'DONE'));
}
const bindStatus = spawnSync('node', ['dist/cli.js', 'bind', 'status'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PERSONAL_DAEMON_CONFIG: configPath },
  encoding: 'utf8',
});
assert.equal(bindStatus.status, 0, bindStatus.stderr);
assert.equal(JSON.parse(bindStatus.stdout).binding.chatId, 'oc-test');

await daemon.enqueue({
  id: 'return-callback-smoke',
  source: 'session-callback',
  kind: 'wake',
  chatId: 'personal-agent-tryout',
  text: 'Child Pi session completed.',
});
const returnContext = JSON.parse(fs.readFileSync(contextFile, 'utf8')) as { chatId: string; eventId: string; sendCount: number };
assert.equal(returnContext.chatId, 'personal-agent-tryout');
assert.equal(returnContext.eventId, 'return-callback-smoke');
assert.equal(JSON.parse(fs.readFileSync(bindingFile, 'utf8')).chatId, 'oc-test');

const sendMain = spawnSync('node', ['dist/cli.js', 'send', '--stdin'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PERSONAL_DAEMON_CONFIG: configPath },
  input: '**hello** from `pi-personal send`\n- list item with `inline code`',
  encoding: 'utf8',
});
assert.equal(sendMain.status, 0, sendMain.stderr);
lines = fs.readFileSync(outbox, 'utf8').trim().split('\n');
assert.equal(lines.length, 3);
let sent = JSON.parse(lines[2]) as { chatId: string; inReplyTo: string; text: string; contextFooter: string; msgType: string; card: { schema?: string; config?: { update_multi?: boolean; width_mode?: string }; body?: { direction?: string; elements: Array<{ tag: string; content?: string; text?: { tag: string; content: string } }> } } };
assert.equal(sent.chatId, 'oc-test');
assert.equal(sent.inReplyTo, 'return-callback-smoke');
assert.equal(sent.text, '**hello** from `pi-personal send`\n- list item with `inline code`');
assert.equal(sent.contextFooter, 'Context usage unavailable');
assert.doesNotMatch(sent.contextFooter, /\b\d+\/\d+ tokens\b/);
assert.doesNotMatch(sent.contextFooter, /\b(messages|pending|model|Pi session)\b/);
assert.equal(sent.msgType, 'interactive');
assert.equal(sent.card.schema, '2.0');
assert.equal(sent.card.config?.update_multi, true);
assert.equal(sent.card.config?.width_mode, 'fill');
assert.equal(sent.card.body?.direction, 'vertical');
const sentElements = sent.card.body?.elements || [];
assert.equal(sentElements[0].tag, 'markdown');
assert.equal(sentElements[0].content, '**hello** from `pi-personal send`\n- list item with `inline code`');
assert.match(sentElements[0].content || '', /^\*\*hello\*\* from `pi-personal send`\n- list item with `inline code`$/);
assert.equal(sentElements[1].tag, 'hr');
assert.equal(sentElements[2].tag, 'markdown');
assert.match(sentElements[2].content || '', /<font color="grey"><font size="small">Context usage unavailable<\/font><\/font>/);
let sentContext = JSON.parse(fs.readFileSync(contextFile, 'utf8')) as { sendCount: number };
assert.equal(sentContext.sendCount, 1);

const create = spawnSync('node', ['dist/cli.js', 'sessions', 'create', '--id', 's1', '--name', 'smoke session', '--prompt', 'first prompt', '--wait'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PERSONAL_DAEMON_CONFIG: configPath },
  encoding: 'utf8',
});
assert.equal(create.status, 0, create.stderr);
const created = JSON.parse(create.stdout) as { id: string; status: string; lastResult: string; notify: boolean; parentCallback?: { queuePath: string }; parentNotificationPath?: string };
assert.equal(created.id, 's1');
assert.equal(created.status, 'completed');
assert.equal(created.notify, true);
assert.ok(created.parentCallback?.queuePath);
assert.ok(created.parentNotificationPath);
assert.equal(fs.existsSync(created.parentNotificationPath), true);
assert.match(created.lastResult, /first prompt/);
await daemon.enqueue(normalizeInbound({ type: 'message', id: 'evt-drain-callbacks', chatId: 'chat-drain-callbacks', text: 'drain callbacks' }, 'test'));
assert.equal(fs.existsSync(created.parentNotificationPath), false);

const sessionSend = spawnSync('node', ['dist/cli.js', 'sessions', 'send', 's1', '--message', 'second prompt', '--wait'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PERSONAL_DAEMON_CONFIG: configPath },
  encoding: 'utf8',
});
assert.equal(sessionSend.status, 0, sessionSend.stderr);
const sentSession = JSON.parse(sessionSend.stdout) as { id: string; status: string; lastResult: string };
assert.equal(sentSession.id, 's1');
assert.equal(sentSession.status, 'completed');
assert.match(sentSession.lastResult, /second prompt/);

const asyncConfigPath = path.join(tmp, 'config-async.json');
const fakePi = path.join(tmp, 'fake-pi.js');
fs.writeFileSync(fakePi, `#!/usr/bin/env node\nconst prompt = process.argv[process.argv.length - 1];\nsetTimeout(() => { console.log('fake pi done: ' + prompt); }, 50);\n`);
fs.chmodSync(fakePi, 0o755);
const asyncConfig = { ...config, agent: { ...config.agent, mock: false, piBin: fakePi, extraArgs: [] } };
fs.writeFileSync(asyncConfigPath, JSON.stringify(asyncConfig));
const asyncCreate = spawnSync('node', ['dist/cli.js', 'sessions', 'create', '--id', 'async1', '--prompt', 'async prompt', '--no-return'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PERSONAL_DAEMON_CONFIG: asyncConfigPath },
  encoding: 'utf8',
});
assert.equal(asyncCreate.status, 0, asyncCreate.stderr);
let asyncStatus = JSON.parse(asyncCreate.stdout) as { id: string; status: string; lastResult?: string; pid?: number };
assert.equal(asyncStatus.id, 'async1');
assert.equal(asyncStatus.status, 'running');
for (let i = 0; i < 30; i++) {
  await new Promise(resolve => setTimeout(resolve, 100));
  const statusCheck = spawnSync('node', ['dist/cli.js', 'sessions', 'status', 'async1'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, PERSONAL_DAEMON_CONFIG: asyncConfigPath },
    encoding: 'utf8',
  });
  assert.equal(statusCheck.status, 0, statusCheck.stderr);
  asyncStatus = JSON.parse(statusCheck.stdout) as { id: string; status: string; lastResult?: string; pid?: number };
  if (asyncStatus.status === 'completed') break;
}
assert.equal(asyncStatus.status, 'completed');
assert.equal(asyncStatus.pid, undefined);
assert.match(asyncStatus.lastResult || '', /fake pi done: async prompt/);

const list = spawnSync('node', ['dist/cli.js', 'sessions', 'list'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PERSONAL_DAEMON_CONFIG: configPath },
  encoding: 'utf8',
});
assert.equal(list.status, 0, list.stderr);
assert.match(list.stdout, /^s1\tcompleted\ttrue/m);

const status = spawnSync('node', ['dist/cli.js', 'sessions', 'status', 's1'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PERSONAL_DAEMON_CONFIG: configPath },
  encoding: 'utf8',
});
assert.equal(status.status, 0, status.stderr);
assert.equal(JSON.parse(status.stdout).id, 's1');

const history = spawnSync('node', ['dist/cli.js', 'sessions', 'history', 's1', '--lines', '20'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PERSONAL_DAEMON_CONFIG: configPath },
  encoding: 'utf8',
});
assert.equal(history.status, 0, history.stderr);
assert.match(history.stdout, /first prompt/);
assert.match(history.stdout, /second prompt/);

const cronCreate = spawnSync('node', ['dist/cli.js', 'cron', 'create', '--id', 'c1', '--prompt', 'cron prompt', '--cron', '0 * * * *', '--target', 'main'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PERSONAL_DAEMON_CONFIG: configPath },
  encoding: 'utf8',
});
assert.equal(cronCreate.status, 0, cronCreate.stderr);
let cronRecord = JSON.parse(cronCreate.stdout) as { id?: string; prompt: string; enabled: boolean; target: string; nextRunAt?: string; schedule: { type: string } };
assert.equal(cronRecord.id, 'c1');
assert.equal(cronRecord.prompt, 'cron prompt');
assert.equal(cronRecord.enabled, true);
assert.equal(cronRecord.target, 'main');
assert.ok(cronRecord.nextRunAt);
assert.equal(loadCronRegistry(config).crons.c1.prompt, 'cron prompt');
const cronList = spawnSync('node', ['dist/cli.js', 'cron', 'list'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PERSONAL_DAEMON_CONFIG: configPath },
  encoding: 'utf8',
});
assert.equal(cronList.status, 0, cronList.stderr);
assert.match(cronList.stdout, /^c1\tscheduled\ttrue\tmain/m);
const cronUpdate = spawnSync('node', ['dist/cli.js', 'cron', 'update', 'c1', '--prompt', 'updated cron prompt', '--at', new Date(Date.now() + 60_000).toISOString(), '--target', 'new', '--disabled'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PERSONAL_DAEMON_CONFIG: configPath },
  encoding: 'utf8',
});
assert.equal(cronUpdate.status, 0, cronUpdate.stderr);
cronRecord = JSON.parse(cronUpdate.stdout) as { id?: string; prompt: string; enabled: boolean; target: string; nextRunAt?: string; schedule: { type: string } };
assert.equal(cronRecord.prompt, 'updated cron prompt');
assert.equal(cronRecord.enabled, false);
assert.equal(cronRecord.target, 'new');
assert.equal(cronRecord.schedule.type, 'at');
const cronDisable = spawnSync('node', ['dist/cli.js', 'cron', 'disable', 'c1'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PERSONAL_DAEMON_CONFIG: configPath },
  encoding: 'utf8',
});
assert.equal(cronDisable.status, 0, cronDisable.stderr);
const cronStatus = spawnSync('node', ['dist/cli.js', 'cron', 'status', 'c1'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PERSONAL_DAEMON_CONFIG: configPath },
  encoding: 'utf8',
});
assert.equal(cronStatus.status, 0, cronStatus.stderr);
assert.equal(JSON.parse(cronStatus.stdout).status, 'disabled');
const cronDelete = spawnSync('node', ['dist/cli.js', 'cron', 'delete', 'c1'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PERSONAL_DAEMON_CONFIG: configPath },
  encoding: 'utf8',
});
assert.equal(cronDelete.status, 0, cronDelete.stderr);
assert.equal(loadCronRegistry(config).crons.c1, undefined);

const runtimeEvents: string[] = [];
const runtimeCronConfig: AppConfig = { ...config, scheduler: { enabled: false, wakeups: [] }, runtime: { contextFile: path.join(tmp, 'cron-context.json'), stateDir: path.join(tmp, 'cron-state') } };
const dueAt = new Date(Date.now() - 1000).toISOString();
spawnSync('node', ['dist/cli.js', 'cron', 'create', '--id', 'once-main', '--prompt', 'one shot main', '--at', dueAt, '--target', 'main'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PERSONAL_DAEMON_CONFIG: writeConfig(tmp, 'config-cron-main.json', runtimeCronConfig) },
  encoding: 'utf8',
});
const runtimeScheduler = new RuntimeCronDispatcher(runtimeCronConfig, async event => {
  runtimeEvents.push(`${event.kind}:${event.source}:${event.text}`);
});
runtimeScheduler.start();
await new Promise(resolve => setTimeout(resolve, 50));
runtimeScheduler.stop();
assert.deepEqual(runtimeEvents, ['wake:runtime-cron:one shot main']);
const completedOnce = loadCronRegistry(runtimeCronConfig).crons['once-main'];
assert.equal(completedOnce.status, 'completed');
assert.equal(completedOnce.enabled, false);
assert.ok(completedOnce.lastFiredAt);

const targetConfig: AppConfig = { ...config, runtime: { contextFile: path.join(tmp, 'cron-target-context.json'), stateDir: path.join(tmp, 'cron-target-state') } };
const targetConfigPath = writeConfig(tmp, 'config-cron-target.json', targetConfig);
spawnSync('node', ['dist/cli.js', 'sessions', 'create', '--id', 'target-s1', '--no-return'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PERSONAL_DAEMON_CONFIG: targetConfigPath },
  encoding: 'utf8',
});
for (const [id, target, prompt] of [
  ['once-new', 'new', 'new target prompt'],
  ['once-session', 'session:target-s1', 'session target prompt'],
  ['fixed-a', 'session:fixed-child', 'fixed child prompt a'],
  ['fixed-b', 'session:fixed-child', 'fixed child prompt b'],
] as const) {
  const createdCron = spawnSync('node', ['dist/cli.js', 'cron', 'create', '--id', id, '--prompt', prompt, '--at', dueAt, '--target', target], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, PERSONAL_DAEMON_CONFIG: targetConfigPath },
    encoding: 'utf8',
  });
  assert.equal(createdCron.status, 0, createdCron.stderr);
}
const aliasCron = spawnSync('node', ['dist/cli.js', 'cron', 'create', '--id', 'fixed-alias', '--prompt', 'fixed alias prompt', '--at', dueAt, '--target-session', 'fixed-alias-child'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PERSONAL_DAEMON_CONFIG: targetConfigPath },
  encoding: 'utf8',
});
assert.equal(aliasCron.status, 0, aliasCron.stderr);
assert.equal(JSON.parse(aliasCron.stdout).target, 'session:fixed-alias-child');
const targetScheduler = new RuntimeCronDispatcher(targetConfig, async () => undefined);
targetScheduler.start();
await new Promise(resolve => setTimeout(resolve, 80));
targetScheduler.stop();
const targetRegistry = loadCronRegistry(targetConfig).crons;
assert.equal(targetRegistry['once-new'].status, 'completed');
assert.equal(targetRegistry['once-session'].status, 'completed');
assert.equal(targetRegistry['fixed-a'].status, 'completed');
assert.equal(targetRegistry['fixed-b'].status, 'completed');
assert.equal(targetRegistry['fixed-alias'].status, 'completed');
const targetSessions = JSON.parse(fs.readFileSync(path.join(targetConfig.runtime.stateDir || '', 'sessions', 'registry.json'), 'utf8')) as { sessions: Record<string, { sessionId: string; lastPrompt?: string }> };
const newTargetSessionCount = Object.values(targetSessions.sessions).filter(session => session.lastPrompt === 'new target prompt').length;
assert.equal(newTargetSessionCount, 1);
assert.equal(targetSessions.sessions['target-s1'].sessionId, 'target-s1');
assert.equal(targetSessions.sessions['target-s1'].lastPrompt, 'session target prompt');
assert.equal(targetSessions.sessions['fixed-child'].sessionId, 'fixed-child');
assert.equal(targetSessions.sessions['fixed-child'].lastPrompt, 'fixed child prompt b');
assert.equal(targetSessions.sessions['fixed-alias-child'].sessionId, 'fixed-alias-child');
assert.equal(targetSessions.sessions['fixed-alias-child'].lastPrompt, 'fixed alias prompt');
const fixedChildLog = fs.readFileSync(path.join(targetConfig.runtime.stateDir || '', 'sessions', 'fixed-child.log'), 'utf8');
assert.match(fixedChildLog, /fixed child prompt a/);
assert.match(fixedChildLog, /fixed child prompt b/);

daemon.stop();
steerDaemon.stop();
console.log('smoke ok', outbox);

async function waitForJsonlLines(file: string, count: number): Promise<string[]> {
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, 'utf8').trim();
      const lines = content ? content.split('\n') : [];
      if (lines.length >= count) return lines;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : [];
}

function localStamp(date: Date | null | undefined): string | undefined {
  if (!date) return undefined;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function writeConfig(dir: string, name: string, value: AppConfig): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}
