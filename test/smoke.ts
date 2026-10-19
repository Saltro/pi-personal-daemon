import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PersonalDaemon } from '../src/daemon.js';
import { normalizeInbound } from '../src/events.js';
import { extractContextUsage } from '../src/pi-runner.js';
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

const daemon = new PersonalDaemon(config);
await daemon.enqueue(normalizeInbound({ type: 'message', id: 'evt-smoke', chatId: 'chat-smoke', text: 'hello smoke' }, 'test'));
assert.equal(fs.existsSync(outbox), false);
await daemon.enqueue(v2);
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

console.log('smoke ok', outbox);
