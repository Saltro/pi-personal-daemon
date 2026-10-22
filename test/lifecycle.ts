import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  daemonStatus,
  readDaemonPid,
  removeDaemonPid,
  stopDaemon,
  writeDaemonPid,
} from '../src/core/daemon/lifecycle.js';
import type { AppConfig } from '../src/types.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-daemon-lifecycle-'));
const config: AppConfig = {
  agent: { sessionId: 'main', cwd: tmp, piBin: 'pi', extraArgs: [], mock: true },
  http: { enabled: false, host: '127.0.0.1', port: 0, path: '/webhook' },
  stdin: { enabled: false },
  sender: { type: 'mock', mockOutbox: path.join(tmp, 'outbox') },
  feishu: {
    appId: '',
    appSecret: '',
    verificationToken: '',
    encryptKey: '',
    baseUrl: '',
    eventMode: 'webhook',
  },
  scheduler: { enabled: false, wakeups: [] },
  runtime: { stateDir: path.join(tmp, 'state') },
};

assert.deepEqual(
  { running: daemonStatus(config).running, stalePid: daemonStatus(config).stalePid },
  { running: false, stalePid: undefined },
  'no pid file means not running',
);

const record = writeDaemonPid(config);
assert.equal(record.pid, process.pid);
assert.equal(readDaemonPid(config)?.pid, process.pid);
assert.equal(daemonStatus(config).running, true, 'the current process is alive');

removeDaemonPid(config, process.pid + 1);
assert.equal(
  readDaemonPid(config)?.pid,
  process.pid,
  'mismatched removal leaves the pid file intact',
);
removeDaemonPid(config, process.pid);
assert.equal(readDaemonPid(config), undefined, 'matching removal deletes the pid file');

fs.writeFileSync(
  path.join(tmp, 'state', 'daemon.pid'),
  JSON.stringify({ pid: 999_999_999, startedAt: 'x' }),
);
const stale = daemonStatus(config);
assert.equal(stale.running, false);
assert.equal(stale.stalePid, 999_999_999);
assert.equal(readDaemonPid(config)?.pid, 999_999_999, 'status does not delete a stale pid file');
removeDaemonPid(config, stale.stalePid);
assert.equal(readDaemonPid(config), undefined);

fs.writeFileSync(path.join(tmp, 'state', 'daemon.pid'), 'not json');
assert.throws(() => readDaemonPid(config), /malformed daemon pid file/);
fs.rmSync(path.join(tmp, 'state', 'daemon.pid'));

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
assert.ok(child.pid);
fs.writeFileSync(
  path.join(tmp, 'state', 'daemon.pid'),
  JSON.stringify({ pid: child.pid, startedAt: '' }),
);
const stopped = await stopDaemon(config, 5000);
assert.equal(stopped.running, false);
assert.equal(stopped.pid, child.pid);
assert.equal(readDaemonPid(config), undefined, 'stop removes the pid file');
await assert.rejects(stopDaemon(config, 100), /daemon is not running/);

console.log('daemon lifecycle tests passed');
