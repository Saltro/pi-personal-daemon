import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/extensions/index.js';
import { createMainAgentRunner } from '../src/core/agents/registry.js';
import {
  type ChannelAdapter,
  createChannelAdapter,
  registerChannelAdapter,
} from '../src/core/channels/registry.js';
import { PersonalDaemon } from '../src/core/daemon/daemon.js';
import { normalizeInbound, toAgentPrompt } from '../src/core/events.js';
import {
  listParentNotifications,
  noticeToInbound,
  writeParentReturnNotification,
} from '../src/core/sessions/callbacks.js';
import { readFeishuChatBinding } from '../src/core/state/binding.js';
import { readCurrentContext } from '../src/core/state/context.js';
import { getStateDb } from '../src/core/state/db.js';
import type { AppConfig, OutboundReply } from '../src/types.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-channels-'));
const config: AppConfig = {
  workspaceDir: tmp,
  agentProfiles: { default: { backend: 'mock' } },
  extensions: { pi: { bin: 'pi', extraArgs: [] }, feishu: { appId: '', appSecret: '' } },
  sender: { type: 'mock', mockOutbox: path.join(tmp, 'outbox') },
  stateDir: path.join(tmp, 'state'),
};
assert.throws(
  () => createChannelAdapter({ ...config, channel: { type: 'missing' } }),
  /Unknown channel/,
);
const received: string[] = [];
const replies: OutboundReply[] = [];
let closed = false;
registerChannelAdapter(
  'test-channel',
  (): ChannelAdapter => ({
    type: 'test-channel',
    label: 'test-channel',
    sender: {
      send: async (reply) => {
        replies.push(reply);
      },
    },
    start: async (onEvent) => {
      await onEvent(
        normalizeInbound(
          { type: 'message', id: 'channel-start', text: 'custom ingress' },
          'custom',
        ),
      );
    },
    close: () => {
      closed = true;
    },
    bindInbound: () => undefined,
    shouldDebounce: () => false,
    dedupeKey: (event) => `custom:${event.id}`,
  }),
);
assert.throws(
  () => registerChannelAdapter('test-channel', () => createChannelAdapter(config)),
  /already registered/,
);
const runner = createMainAgentRunner(config);
Object.assign(runner, {
  promptAndWait: async (prompt: string) => {
    received.push(prompt);
    return '';
  },
});
const daemon = new PersonalDaemon({ ...config, channel: { type: 'test-channel' } }, { runner });
daemon.start();
await daemon.enqueue(normalizeInbound({ type: 'wake', prompt: 'queue barrier' }, 'test'));
assert.ok(received.some((prompt) => prompt.includes('custom ingress')));
assert.ok(received.every((prompt) => !prompt.includes('Feishu')));
await daemon.enqueue(
  normalizeInbound({ type: 'message', id: 'channel-start', text: 'duplicate' }, 'custom'),
);
assert.equal(received.filter((prompt) => prompt.includes('duplicate')).length, 0);
await createChannelAdapter({ ...config, channel: { type: 'test-channel' } }).sender.send({
  chatId: 'fixed',
  inReplyTo: 'manual',
  text: 'custom egress',
});
assert.equal(replies[0].text, 'custom egress');
daemon.stop();
assert.equal(closed, true);
await assert.rejects(daemon.enqueue(normalizeInbound('after stop')), /stopped/);
assert.doesNotMatch(toAgentPrompt(normalizeInbound('plain text')), /Feishu|Pi session/);

const stdinConfig: AppConfig = {
  ...config,
  channel: { type: 'stdin' },
  stateDir: path.join(tmp, 'stdin-state'),
};
const stdinDaemon = new PersonalDaemon(stdinConfig);
await stdinDaemon.enqueue(
  normalizeInbound(
    { type: 'message', chatId: 'terminal-destination', text: 'stdin ingress' },
    'stdin',
  ),
);
assert.equal(readFeishuChatBinding(stdinConfig)?.chatId, 'terminal-destination');
assert.equal(readCurrentContext(stdinConfig).textChars, 'stdin ingress'.length);
stdinDaemon.stop();
const file = path.join(tmp, 'config.json');
fs.writeFileSync(file, JSON.stringify(stdinConfig));
const send = spawnSync(
  process.execPath,
  [path.resolve(import.meta.dirname, '../dist/index.js'), 'send', 'stdin egress'],
  {
    cwd: tmp,
    env: { ...process.env, RETRIEVER_CONFIG: file },
    encoding: 'utf8',
    timeout: 5000,
  },
);
assert.equal(send.status, 0, send.stderr);
assert.equal(send.stdout, 'stdin egress\n');
assert.equal(readCurrentContext(stdinConfig).sendCount, 1);

const queuedConfig = { ...config, stateDir: path.join(tmp, 'queued-state') };
const queuedPrompts: string[] = [];
let active = false;
let releaseFirst!: () => void;
let startedFirst!: () => void;
let startedSecond!: () => void;
const firstStarted = new Promise<void>((resolve) => {
  startedFirst = resolve;
});
const secondStarted = new Promise<void>((resolve) => {
  startedSecond = resolve;
});
const firstReleased = new Promise<void>((resolve) => {
  releaseFirst = resolve;
});
const queuedRunner = createMainAgentRunner(queuedConfig);
Object.assign(queuedRunner, {
  capabilities: { prompt: true, steer: false, history: false, contextUsage: false },
  isRunning: () => active,
  steer: async () => {
    assert.fail('unsupported steer must not be called');
  },
  promptAndWait: async (prompt: string) => {
    assert.equal(active, false, 'non-steer backend prompts must not overlap');
    active = true;
    queuedPrompts.push(prompt);
    if (queuedPrompts.length === 1) {
      startedFirst();
      await firstReleased;
    } else startedSecond();
    active = false;
    return '';
  },
});
const queuedDaemon = new PersonalDaemon(queuedConfig, { runner: queuedRunner, debounceMs: 10 });
void queuedDaemon.enqueue(
  normalizeInbound({ type: 'message', id: 'queued-first', text: 'first queued prompt' }, 'feishu'),
);
await firstStarted;
void queuedDaemon.enqueue(
  normalizeInbound(
    { type: 'message', id: 'queued-second', text: 'second queued prompt' },
    'feishu',
  ),
);
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(queuedPrompts.length, 1);
releaseFirst();
await secondStarted;
await queuedDaemon.enqueue(normalizeInbound({ type: 'wake', prompt: 'queued barrier' }, 'test'));
assert.match(queuedPrompts[0], /first queued prompt/);
assert.match(queuedPrompts[1], /second queued prompt/);
queuedDaemon.stop();

const callbackConfig = { ...config, stateDir: path.join(tmp, 'callback-state') };
writeParentReturnNotification(
  callbackConfig,
  { sessionId: 'parent', cwd: tmp, queuePath: '', createdAt: new Date().toISOString() },
  'retry callback',
);
const callback = listParentNotifications(callbackConfig)[0];
assert.doesNotMatch(
  toAgentPrompt(noticeToInbound(callback), 'terminal'),
  /Feishu|Child Pi session/,
);
const completion = noticeToInbound({
  type: 'session.completed',
  id: 'completion-neutral',
  createdAt: new Date().toISOString(),
  parent: callback.parent,
  child: {
    id: 'process-child',
    sessionId: 'process-child',
    cwd: tmp,
    status: 'completed',
    logPath: '',
    updatedAt: new Date().toISOString(),
  },
});
assert.doesNotMatch(toAgentPrompt(completion, 'terminal'), /Feishu|Child Pi session/);
const failingRunner = createMainAgentRunner(callbackConfig);
Object.assign(failingRunner, {
  promptAndWait: async () => {
    throw new Error('fake agent failure');
  },
});
const failingDaemon = new PersonalDaemon(callbackConfig, { runner: failingRunner });
await assert.rejects(
  failingDaemon.enqueue(normalizeInbound({ type: 'wake', prompt: 'trigger drain' }, 'test')),
  /fake agent failure/,
);
assert.equal(listParentNotifications(callbackConfig).length, 1);
failingDaemon.stop();

const backlogConfig = { ...config, stateDir: path.join(tmp, 'backlog-state') };
const parent = { sessionId: 'main', cwd: tmp, queuePath: '', createdAt: new Date().toISOString() };
const backlogIds = [
  writeParentReturnNotification(backlogConfig, parent, 'slow callback'),
  writeParentReturnNotification(backlogConfig, parent, 'waiting callback'),
];
let releaseCallback!: () => void;
let callbackStarted!: () => void;
let activeCallback: string | undefined;
const callbackStartedTask = new Promise<void>((resolve) => {
  callbackStarted = resolve;
});
const callbackReleased = new Promise<void>((resolve) => {
  releaseCallback = resolve;
});
const backlogRunner = createMainAgentRunner(backlogConfig);
Object.assign(backlogRunner, {
  promptAndWait: async () => {
    activeCallback = readCurrentContext(backlogConfig).eventId;
    assert.ok(activeCallback);
    callbackStarted();
    await callbackReleased;
    return '';
  },
});
const backlogDaemon = new PersonalDaemon(backlogConfig, { runner: backlogRunner });
const stoppedDelivery = backlogDaemon.enqueue(
  normalizeInbound({ type: 'wake', prompt: 'after callbacks' }, 'test'),
);
const rejectedAfterStop = assert.rejects(stoppedDelivery, /stopped/i);
await callbackStartedTask;
const waitingCallback = backlogIds.find((id) => id !== activeCallback)!;
const waitingRow = () =>
  getStateDb(backlogConfig)
    .prepare('SELECT status, attempts FROM parent_notifications WHERE id=?')
    .get(waitingCallback)!;
assert.equal(waitingRow().status, 'pending');
assert.equal(waitingRow().attempts, 0);
backlogDaemon.stop();
releaseCallback();
await rejectedAfterStop;
assert.equal(waitingRow().status, 'pending');
assert.equal(waitingRow().attempts, 0);
const resumedRunner = createMainAgentRunner(backlogConfig);
const resumedPrompts: string[] = [];
Object.assign(resumedRunner, {
  promptAndWait: async (prompt: string) => {
    resumedPrompts.push(prompt);
    return '';
  },
});
const resumedDaemon = new PersonalDaemon(backlogConfig, { runner: resumedRunner });
await resumedDaemon.enqueue(normalizeInbound({ type: 'wake', prompt: 'resumed barrier' }, 'test'));
const waitingText = waitingCallback === backlogIds[0] ? 'slow callback' : 'waiting callback';
assert.ok(resumedPrompts.some((prompt) => prompt.includes(waitingText)));
assert.equal(listParentNotifications(backlogConfig).length, 0);
resumedDaemon.stop();
console.log('channels ok');
