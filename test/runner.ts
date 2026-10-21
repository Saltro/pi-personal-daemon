import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { agentProcessDetached, agentProcessGroupAlive } from '../src/process-control.js';
import { PiRpcRunner, type PiRpcRunnerOptions } from '../src/pi-runner.js';
import type { AppConfig } from '../src/types.js';

interface CommandRecord {
  id: string;
  type: string;
  message?: string;
}

class FakePi extends EventEmitter {
  pid: number | undefined = 12345;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      const command = JSON.parse(String(chunk)) as CommandRecord;
      this.commands.push(command);
      this.onCommand?.(command);
      callback();
    },
  });
  commands: CommandRecord[] = [];
  kills: string[] = [];
  onCommand?: (command: CommandRecord) => void;

  kill(signal: string): boolean {
    this.kills.push(signal);
    return true;
  }

  record(record: Record<string, unknown>): void {
    this.stdout.write(JSON.stringify(record) + '\n');
  }

  respond(command: CommandRecord, data: unknown): void {
    this.record({ type: 'response', id: command.id, command: command.type, success: true, data });
  }

  exit(): void {
    this.emit('exit', 0, null);
    this.emit('close', 0, null);
  }
}

function config(): AppConfig {
  return {
    agent: { sessionId: 'runner-test', cwd: process.cwd(), piBin: 'fake-pi', extraArgs: [], mock: false },
    http: { enabled: false, host: '127.0.0.1', port: 0, path: '/webhook' },
    stdin: { enabled: false },
    sender: { type: 'mock', mockOutbox: '' },
    feishu: { appId: '', appSecret: '', verificationToken: '', encryptKey: '', baseUrl: '', eventMode: 'webhook' },
    scheduler: { enabled: false, wakeups: [] },
    runtime: {},
  };
}

function fakeRunner(children: FakePi[], options: PiRpcRunnerOptions = {}): PiRpcRunner {
  let index = 0;
  return new PiRpcRunner(config(), {
    commandTimeoutMs: 200,
    settledTimeoutMs: 200,
    ...options,
    signalProcess: (child, signal) => child.kill(signal),
    confirmExit: options.confirmExit ?? (() => true),
    spawn: (_command, _args, spawnOptions) => {
      assert.equal(spawnOptions.detached, agentProcessDetached);
      const child = children[index++];
      assert.ok(child, 'unexpected replacement process');
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });
}

function assertClean(runner: PiRpcRunner): void {
  assert.equal(runner.isRunning(), false);
  assert.equal(runner['proc']?.pending.size ?? 0, 0);
  assert.equal(runner['proc']?.waiters.size ?? 0, 0);
}

await test('missing command ACK has its own deadline, including before a prompt', async () => {
  const first = new FakePi();
  const second = new FakePi();
  second.onCommand = command => second.respond(command, { recovered: true });
  const runner = fakeRunner([first, second], { commandTimeoutMs: 25, settledTimeoutMs: 1000 });
  try {
    await assert.rejects(runner.getState(), /timed out waiting for pi rpc get_state response/);
    assert.deepEqual(first.kills, ['SIGKILL']);
    assertClean(runner);
    await assert.rejects(runner.getState(), /process is stopping/);
    assert.equal(second.commands.length, 0);
    first.exit();
    assert.deepEqual(await runner.getState(), { recovered: true });
  } finally {
    runner.close();
    first.exit();
    second.exit();
  }
});

await test('a prompt with no ACK times out and rejects all settled waiters', async () => {
  const child = new FakePi();
  const runner = fakeRunner([child], { commandTimeoutMs: 25, settledTimeoutMs: 1000 });
  try {
    const prompt = assert.rejects(runner.promptAndWait('no ACK'), /prompt response/);
    const settled = assert.rejects(runner.waitForSettled(), /prompt response/);
    await Promise.all([prompt, settled]);
    assertClean(runner);
    assert.deepEqual(child.kills, ['SIGKILL']);
  } finally {
    runner.close();
    child.exit();
  }
});

await test('ACK followed immediately by exit is failure, not false settled success', async () => {
  const child = new FakePi();
  child.onCommand = command => {
    child.respond(command, { disposition: 'started' });
    child.exit();
  };
  const runner = fakeRunner([child]);
  await assert.rejects(runner.promptAndWait('exit after ACK'), /pi rpc exited/);
  assertClean(runner);
  await assert.rejects(runner.waitForSettled(), /pi rpc exited/);
  assert.equal(runner['proc'], null);
  assert.deepEqual(child.kills, ['SIGKILL']);
});

await test('exit after ACK rejects existing waiters without waiting for timeout', async () => {
  const child = new FakePi();
  child.onCommand = command => child.respond(command, { disposition: 'started' });
  const runner = fakeRunner([child], { settledTimeoutMs: 1000 });
  const prompt = assert.rejects(runner.promptAndWait('active prompt'), /pi rpc exited/);
  const firstWaiter = assert.rejects(runner.waitForSettled(), /pi rpc exited/);
  const secondWaiter = assert.rejects(runner.waitForSettled(), /pi rpc exited/);
  await nextTurn();
  child.exit();
  await Promise.all([prompt, firstWaiter, secondWaiter]);
  assertClean(runner);
});

await test('spawn error rejects commands without an unhandled child error', async () => {
  const child = new FakePi();
  child.pid = undefined;
  const runner = fakeRunner([child]);
  const command = assert.rejects(runner.getState(), /fake spawn failure/);
  child.emit('error', new Error('fake spawn failure'));
  child.emit('close', -2, null);
  await command;
  assertClean(runner);
  assert.equal(runner['proc'], null);
  assert.deepEqual(child.kills, []);
});

await test('a real missing executable is handled without invoking Pi', async () => {
  const appConfig = config();
  appConfig.agent.piBin = `/nonexistent-pi-runner-test-${process.pid}`;
  const runner = new PiRpcRunner(appConfig, { commandTimeoutMs: 1000 });
  try {
    await assert.rejects(runner.getState(), /ENOENT/);
    assertClean(runner);
  } finally {
    runner.close();
  }
});

await test('a synchronous spawn failure rejects without marking the runner busy', async () => {
  const runner = new PiRpcRunner(config(), { spawn: () => { throw new Error('synchronous spawn failure'); } });
  await assert.rejects(runner.promptAndWait('spawn failure'), /synchronous spawn failure/);
  assertClean(runner);
});

await test('close rejects pending commands and waiters, with once-only cleanup', async () => {
  const child = new FakePi();
  const runner = fakeRunner([child]);
  const prompt = assert.rejects(runner.promptAndWait('close pending'), /runner closed/);
  const command = assert.rejects(runner.getState(), /runner closed/);
  const waiter = assert.rejects(runner.waitForSettled(), /runner closed/);
  runner.close();
  runner.close();
  child.emit('error', new Error('late child error'));
  child.stdin.emit('error', new Error('late stdin error'));
  child.exit();
  await Promise.all([prompt, command, waiter]);
  assertClean(runner);
  assert.deepEqual(child.kills, ['SIGKILL']);
});

await test('failed termination still rejects waiters and prevents an overlapping replacement', async () => {
  const child = new FakePi();
  const runner = fakeRunner([child]);
  child.kill = () => { throw new Error('fake kill failure'); };
  const pending = assert.rejects(runner.promptAndWait('failed termination'), /runner closed/);
  const waiter = assert.rejects(runner.waitForSettled(), /runner closed/);
  assert.doesNotThrow(() => runner.close());
  await Promise.all([pending, waiter]);
  assertClean(runner);
  await assert.rejects(runner.getState(), /process is stopping/);
  child.exit();
  assert.notEqual(runner['proc'], null, 'unknown group termination must keep the stopping guard even after close');
  await assert.rejects(runner.getState(), /process is stopping/);
});

await test('leader exit keeps the guard until inherited pipes close, without repeat group signals', async () => {
  const child = new FakePi();
  const runner = fakeRunner([child]);
  const pending = assert.rejects(runner.getState(), /pi rpc exited/);
  child.emit('exit', 0, null);
  await pending;
  assertClean(runner);
  assert.notEqual(runner['proc'], null);
  await assert.rejects(runner.getState(), /process is stopping/);
  assert.deepEqual(child.kills, ['SIGKILL']);
  child.emit('close', 0, null);
  assert.equal(runner['proc'], null);
  child.emit('exit', 0, null);
  assert.deepEqual(child.kills, ['SIGKILL']);
});

await test('close keeps the stopping guard until async group-exit verification succeeds', async () => {
  const first = new FakePi();
  const second = new FakePi();
  let confirm: ((exited: boolean) => void) | undefined;
  let confirmations = 0;
  const runner = fakeRunner([first, second], {
    confirmExit: () => {
      confirmations++;
      return new Promise<boolean>(resolve => { confirm = resolve; });
    },
  });
  const pending = assert.rejects(runner.getState(), /pi rpc exited/);
  first.exit();
  await pending;
  await assert.rejects(runner.getState(), /process is stopping/);
  first.emit('close', 0, null);
  assert.equal(confirmations, 1, 'only one bounded verification runs per generation');
  confirm?.(true);
  await Promise.resolve();
  assert.equal(runner['proc'], null);
  second.onCommand = command => second.respond(command, { recovered: true });
  assert.deepEqual(await runner.getState(), { recovered: true });
  runner.close();
  second.exit();
  confirm?.(true);
  await Promise.resolve();
});

for (const mode of ['not-exited', 'rejected'] as const) {
  await test(`unconfirmed group exit (${mode}) never permits a replacement`, async () => {
    const child = new FakePi();
    const runner = fakeRunner([child], {
      confirmExit: () => mode === 'not-exited' ? Promise.resolve(false) : Promise.reject(new Error('fake verification failure')),
    });
    const pending = assert.rejects(runner.getState(), /pi rpc exited/);
    child.exit();
    await pending;
    await Promise.resolve();
    await Promise.resolve();
    assertClean(runner);
    await assert.rejects(runner.getState(), /process is stopping/);
  });
}

await test('child close without exit rejects pending commands and clears state', async () => {
  const child = new FakePi();
  const runner = fakeRunner([child]);
  const pending = assert.rejects(runner.promptAndWait('child closed'), /pi rpc closed/);
  const waiter = assert.rejects(runner.waitForSettled(), /pi rpc closed/);
  child.emit('close', 1, null);
  await Promise.all([pending, waiter]);
  assertClean(runner);
  assert.equal(runner['proc'], null);
});

for (const mode of ['throw', 'callback', 'error', 'closed'] as const) {
  await test(`stdin ${mode} failure cleans up the RPC instead of leaving promises pending`, async () => {
    const child = new FakePi();
    const runner = fakeRunner([child]);
    runner.start();
    if (mode === 'throw') {
      child.stdin.write = (() => { throw new Error('write failed'); }) as typeof child.stdin.write;
    } else if (mode === 'callback') {
      child.stdin.write = ((_chunk: unknown, callback: (error: Error) => void) => {
        callback(new Error('write failed'));
        return false;
      }) as typeof child.stdin.write;
    }
    const pending = assert.rejects(runner.promptAndWait('write error'), /write failed|stdin closed/);
    if (mode === 'error') child.stdin.emit('error', new Error('write failed'));
    if (mode === 'closed') child.stdin.emit('close');
    await pending;
    assertClean(runner);
    assert.deepEqual(child.kills, ['SIGKILL']);
    runner.close();
    child.exit();
  });
}

await test('settled timeout kills the busy process and blocks replacement until close', async () => {
  const first = new FakePi();
  const second = new FakePi();
  first.onCommand = command => first.respond(command, { disposition: 'started' });
  second.onCommand = command => {
    if (command.type === 'prompt') {
      second.respond(command, { disposition: 'started' });
      second.record({ type: 'agent_settled' });
    } else {
      second.respond(command, { text: 'recovered reply' });
    }
  };
  const runner = fakeRunner([first, second], { settledTimeoutMs: 25 });
  const prompt = assert.rejects(runner.promptAndWait('will not settle'), /timed out waiting for agent_settled/);
  const waiter = assert.rejects(runner.waitForSettled(), /timed out waiting for agent_settled/);
  await Promise.all([prompt, waiter]);
  assertClean(runner);
  assert.deepEqual(first.kills, ['SIGKILL']);
  await assert.rejects(runner.promptAndWait('must not overlap'), /process is stopping/);
  assert.equal(second.commands.length, 0);
  first.exit();
  assert.equal(await runner.promptAndWait('recovery'), 'recovered reply');
  assertClean(runner);
  runner.close();
  second.exit();
});

await test('old process records, exit and prompt continuation cannot affect a new generation', async () => {
  const first = new FakePi();
  const second = new FakePi();
  const runner = fakeRunner([first, second]);
  runner.start();
  const oldLine = runner['proc']!.reader.listeners('line')[0] as (line: string) => void;
  const oldPrompt = assert.rejects(runner.promptAndWait('old'), /pi rpc exited/);
  first.respond(first.commands[0], { disposition: 'started' });
  first.exit();
  second.onCommand = command => {
    second.respond(command, command.type === 'prompt' ? { disposition: 'started' } : { text: 'new reply' });
  };
  const newPrompt = runner.promptAndWait('new');
  await oldPrompt;
  oldLine(JSON.stringify({ type: 'agent_settled' }));
  oldLine(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'stale' } }));
  first.emit('exit', 7, null);
  first.emit('close', 7, null);
  assert.equal(runner.isRunning(), true);
  assert.equal(runner['proc']?.lastAssistantText, '');
  assert.equal(runner['proc']?.child, second);
  await assert.rejects(runner.promptAndWait('overlap'), /already running/);
  second.record({ type: 'agent_settled' });
  assert.equal(await newPrompt, 'new reply');
  runner.close();
  second.exit();
});

await test('timely settled resolves all waiters and returns the RPC final assistant text', async () => {
  const child = new FakePi();
  child.onCommand = command => {
    if (command.type === 'prompt') {
      child.respond(command, { disposition: 'queued' });
      child.record({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'streamed' } });
    } else if (command.type === 'steer') {
      child.respond(command, { disposition: 'queued' });
    } else {
      child.respond(command, { text: 'final RPC reply' });
    }
  };
  const runner = fakeRunner([child]);
  const prompt = runner.promptAndWait('timely');
  const firstWaiter = runner.waitForSettled();
  const secondWaiter = runner.waitForSettled();
  assert.deepEqual(await runner.steer('additional message'), { disposition: 'queued' });
  child.record({ type: 'agent_settled' });
  await Promise.all([firstWaiter, secondWaiter]);
  assert.equal(await prompt, 'final RPC reply');
  assertClean(runner);
  assert.deepEqual(child.kills, []);
  runner.close();
  child.exit();
});

await test('settled before ACK is not missed; final text RPC failure keeps streamed fallback', async () => {
  const child = new FakePi();
  child.onCommand = command => {
    if (command.type === 'prompt') {
      child.record({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'streamed fallback' } });
      child.record({ type: 'agent_settled' });
      child.respond(command, { disposition: 'started' });
    } else {
      child.record({ type: 'response', id: command.id, command: command.type, success: false, error: 'no last text' });
    }
  };
  const runner = fakeRunner([child]);
  assert.equal(await runner.promptAndWait('quick prompt'), 'streamed fallback');
  assertClean(runner);
  assert.deepEqual(child.kills, []);
  runner.close();
  child.exit();
});

await test('handled prompt bypasses settled and context extraction preserves main RPC behavior', async () => {
  const child = new FakePi();
  child.onCommand = command => {
    if (command.type === 'prompt') child.respond(command, { disposition: 'handled' });
    else if (command.type === 'get_state') child.respond(command, { model: { contextWindow: 100000 } });
    else if (command.type === 'get_messages') child.respond(command, { messages: [{ role: 'assistant', usage: { input: 20000 } }] });
    else child.respond(command, { text: 'handled reply' });
  };
  const runner = fakeRunner([child]);
  const prompt = runner.promptAndWait('handled');
  const waiter = runner.waitForSettled();
  assert.equal(await prompt, 'handled reply');
  await waiter;
  assert.deepEqual(await runner.getContextUsage(), {
    text: 'Context 20%', source: 'pi-rpc get_messages latest assistant usage and model contextWindow',
  });
  assertClean(runner);
  runner.close();
  child.exit();
});

for (const mode of ['timeout', 'leader-exit', 'ignored-pipes'] as const) {
  await test(`Unix process group ${mode} cleanup verifies descendants are gone before recovery`, { skip: !agentProcessDetached }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-runner-tree-'));
    const heartbeat = path.join(tmp, 'heartbeat');
    const descendantPidFile = path.join(tmp, 'descendant.pid');
    const executable = path.join(tmp, 'fake-rpc.cjs');
    const descendantSource = `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(descendantPidFile)}, String(process.pid));
      const timer = setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, 'x'), 10);
      process.on('SIGTERM', () => {});
    `;
    fs.writeFileSync(executable, `#!/usr/bin/env node
      const fs = require('node:fs');
      const { spawn } = require('node:child_process');
      const readline = require('node:readline');
      let descendant;
      const reader = readline.createInterface({ input: process.stdin });
      reader.on('line', line => {
        const command = JSON.parse(line);
        if (command.type === 'prompt') {
          descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: ${JSON.stringify(mode === 'ignored-pipes' ? 'ignore' : ['ignore', 'inherit', 'inherit'])} });
          const ready = setInterval(() => {
            if (!fs.existsSync(${JSON.stringify(heartbeat)})) return;
            clearInterval(ready);
            console.log(JSON.stringify({ type: 'response', command: command.type, id: command.id, success: true, data: { disposition: 'started' } }));
            if (${JSON.stringify(mode)} !== 'timeout') process.exit(0);
          }, 5);
        } else {
          console.log(JSON.stringify({ type: 'response', command: command.type, id: command.id, success: true, data: { recovered: true } }));
        }
      });
    `);
    fs.chmodSync(executable, 0o755);
    const appConfig = config();
    appConfig.agent.piBin = executable;
    const children: ChildProcessWithoutNullStreams[] = [];
    const runner = new PiRpcRunner(appConfig, {
      commandTimeoutMs: 2000,
      settledTimeoutMs: 25,
      spawn: (command, args, options) => {
        assert.equal(options.detached, true);
        if (children.length) assert.equal(agentProcessGroupAlive(children[0]), false, 'old group must be verified gone before replacement spawn');
        const child = spawn(command, args, options);
        children.push(child);
        return child;
      },
    });
    let closed = false;
    try {
      const rejected = assert.rejects(runner.promptAndWait('spawn descendant'), mode === 'timeout' ? /agent_settled/ : /pi rpc exited/);
      const firstChild = children[0];
      const firstClosed = once(firstChild, 'close');
      await rejected;
      await firstClosed;
      await waitForReset(runner);
      assert.equal(agentProcessGroupAlive(firstChild), false);
      assertClean(runner);
      assert.equal(runner['proc'], null);
      assert.ok(fs.existsSync(descendantPidFile));
      const size = fs.statSync(heartbeat).size;
      await delay(60);
      assert.equal(fs.statSync(heartbeat).size, size, 'descendant must not continue writing after cleanup');
      assert.deepEqual(await runner.getState(), { recovered: true });
      assert.equal(children.length, 2, 'replacement starts only after old group closes');
      const secondClosed = once(children[1], 'close');
      runner.close();
      await secondClosed;
      await waitForReset(runner);
      closed = true;
    } finally {
      runner.close();
      if (!closed && runner['proc']) {
        const child = runner['proc'].child;
        if (child.exitCode === null && child.signalCode === null) await once(child, 'close');
      }
      if (fs.existsSync(descendantPidFile)) {
        try { process.kill(Number(fs.readFileSync(descendantPidFile, 'utf8')), 'SIGKILL'); } catch { /* Already terminated. */ }
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

async function waitForReset(runner: PiRpcRunner): Promise<void> {
  const deadline = Date.now() + 2000;
  while (runner['proc']) {
    assert.ok(Date.now() < deadline, 'bounded process-group confirmation did not reset the runner');
    await delay(10);
  }
}

await test('mock methods do not spawn or schedule execution timers', async () => {
  const appConfig = config();
  appConfig.agent.mock = true;
  const runner = new PiRpcRunner(appConfig, { spawn: () => { throw new Error('must not spawn'); } });
  runner.start();
  assert.equal(await runner.promptAndWait('hello mock'), 'mock pi reply: hello mock');
  assert.deepEqual(await runner.steer('steer'), { disposition: 'queued' });
  await runner.waitForSettled();
  assert.deepEqual(await runner.getMessages(), { messages: [] });
  assert.deepEqual(await runner.getContextUsage(), { text: 'Context usage unavailable', source: 'pi-rpc context usage unavailable' });
  assertClean(runner);
  runner.close();
});
