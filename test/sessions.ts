import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deleteCron, getCron, makeRuntimeCron, putCron } from '../src/cron-registry.js';
import { dispatchRuntimeCron, dueRuntimeCrons, markRuntimeCronRunning, RuntimeCronDispatcher } from '../src/runtime-cron-dispatch.js';
import { claimSessionRun, getSession, insertSession, loadRegistry, newSessionRecord, putSession, refreshSessionStatus, updateSessionRun } from '../src/session-registry.js';
import { finishSessionRun, runSessionPrompt, selectSessionAgent } from '../src/session-service.js';
import { listParentNotifications } from '../src/session-callbacks.js';
import type { AppConfig } from '../src/types.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-personal-sessions-'));
const configPath = path.join(tmp, 'config.json');
const foreignCwd = path.join(tmp, 'foreign');
fs.mkdirSync(foreignCwd);
const harness = path.join(tmp, 'plain-harness.cjs');
const descendantPidFile = path.join(tmp, 'descendant.pid');
const treeHarness = path.join(tmp, 'tree-harness.cjs');
const descendantCode = `require('node:fs').writeFileSync(${JSON.stringify(descendantPidFile)},String(process.pid));setInterval(()=>{},1000);`;
fs.writeFileSync(treeHarness, `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:['ignore',1,2]});setInterval(()=>{},1000);`);
const unicodeHarness = path.join(tmp, 'unicode-harness.cjs');
fs.writeFileSync(unicodeHarness, `const bytes=Buffer.from('你好🙂');let i=0;const timer=setInterval(()=>{process.stdout.write(bytes.subarray(i,i+1));if(++i===bytes.length)clearInterval(timer);},5);`);
fs.writeFileSync(harness, `const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{if(process.argv.includes('--print'))process.exit(42);console.log('START '+process.pid);setTimeout(()=>{console.log(JSON.stringify({prompt,pid:process.pid,config:process.env.PERSONAL_DAEMON_CONFIG,path:process.env.PATH,session:process.env.PI_PERSONAL_SESSION_ID}));},1200);});`);
const config: AppConfig = {
  agent: { sessionId: 'main', cwd: tmp, piBin: 'pi', extraArgs: [], mock: true },
  agentProfiles: {
    fast: { backend: 'mock', replyPrefix: 'saved-profile: ' },
    plain: { backend: 'process', command: process.execPath, args: [harness] },
    absent: { backend: 'process', command: path.join(tmp, 'missing-agent') },
    timeout: { backend: 'process', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 50 },
    tree: { backend: 'process', command: process.execPath, args: [treeHarness], timeoutMs: 200 },
    unicode: { backend: 'process', command: process.execPath, args: [unicodeHarness] },
  },
  http: { enabled: false, host: '127.0.0.1', port: 0, path: '/' },
  stdin: { enabled: false },
  sender: { type: 'mock', mockOutbox: path.join(tmp, 'outbox') },
  feishu: { appId: '', appSecret: '', verificationToken: '', encryptKey: '', baseUrl: '', eventMode: 'webhook' },
  scheduler: { enabled: false, wakeups: [] },
  runtime: { stateDir: path.join(tmp, 'state'), configPath },
};
const returnHarness = path.join(tmp, 'return-harness.cjs');
fs.writeFileSync(returnHarness, `const {execFileSync}=require('node:child_process');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{execFileSync(process.execPath,[${JSON.stringify(path.join(project, 'dist', 'cli.js'))},'return','--stdin'],{input:prompt,stdio:['pipe','pipe','inherit']});console.log('explicit return queued');});`);
config.agentProfiles!.returns = { backend: 'process', command: process.execPath, args: [returnHarness] };
fs.writeFileSync(configPath, JSON.stringify(config));
const cli = path.join(project, 'dist', 'cli.js');
const env: NodeJS.ProcessEnv = { ...process.env, PERSONAL_DAEMON_CONFIG: configPath };
for (const key of ['PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_PERSONAL_SESSION_ID', 'PI_PERSONAL_PARENT_CALLBACK', 'PI_DAEMON_AGENT_PROFILE', 'PI_DAEMON_MOCK', 'PI_DAEMON_STATE_DIR']) delete env[key];
function command(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cli, 'sessions', ...args], { cwd: foreignCwd, encoding: 'utf8', env: { ...env, ...extraEnv }, timeout: 15_000 });
}
function success(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const result = command(args, extraEnv);
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(result.stdout);
  assert.equal(typeof record.autoReturn, 'boolean');
  assert.equal(Object.hasOwn(record, 'notify'), false, 'CLI session records expose autoReturn only');
  return record;
}
async function settled(id: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const record = getSession(config, id);
    if (record.status !== 'running') return record;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`session did not settle: ${id}`);
}
try {
  assert.ok(fs.existsSync(cli), 'build before running sessions tests');
  const help = command(['--help']);
  assert.equal(help.status, 2);
  assert.match(help.stderr, /--return\|--no-return/);
  assert.doesNotMatch(help.stderr, /notify/i, 'CLI usage advertises return flags only');
  for (const wait of [true, false]) {
    const flag = '--no-return';
    const id = `explicit-${wait}`;
    const parentEnv = { PI_SESSION_ID: 'main' };
    const created = success(['create', '--id', id, '--agent', 'returns', '--prompt', `create ${id}`, flag, ...(wait ? ['--wait'] : [])], parentEnv);
    assert.equal(created.autoReturn, false);
    assert.equal(created.parentCallback.sessionId, 'main');
    assert.equal((await settled(id)).status, 'completed');
    const continued = success(['send', id, '--message', `continue ${id}`, flag, '--wait']);
    assert.equal(continued.autoReturn, false);
    assert.deepEqual(continued.parentCallback, created.parentCallback);
    const notices = listParentNotifications(config).filter(notice => notice.child?.id === id);
    assert.equal(notices.length, 2, 'create/send must enqueue only the explicit returns');
    assert.ok(notices.every(notice => notice.type === 'session.return' && notice.parent.sessionId === 'main'));
    assert.equal(continued.parentNotificationPath, undefined);
    const fallback = spawnSync(process.execPath, [cli, 'return', '--stdin'], {
      cwd: foreignCwd, encoding: 'utf8', input: `registry fallback ${id}`, env: { ...env, PI_PERSONAL_SESSION_ID: id }, timeout: 15_000,
    });
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.equal(listParentNotifications(config).filter(notice => notice.child?.id === id).length, 3);
  }
  const noParentReturn = success(['create', '--id', 'no-parent-return', '--agent', 'fast', '--return', '--prompt', 'complete without caller', '--wait']);
  assert.equal(noParentReturn.autoReturn, true, 'explicit --return is not silently disabled without a parent');
  assert.equal(noParentReturn.status, 'completed');
  assert.equal(noParentReturn.lastResult, 'saved-profile: complete without caller');
  assert.equal(noParentReturn.parentCallback, undefined);
  assert.equal(noParentReturn.parentNotificationPath, undefined);
  assert.equal(noParentReturn.error, 'return failed: parent callback metadata missing');
  assert.equal(listParentNotifications(config).filter(notice => notice.child?.id === noParentReturn.id).length, 0);
  const noParentContinued = success(['send', noParentReturn.id, '--message', 'continue without caller', '--return', '--wait']);
  assert.equal(noParentContinued.autoReturn, true);
  assert.equal(noParentContinued.error, 'return failed: parent callback metadata missing');
  assert.doesNotMatch(JSON.stringify(noParentContinued), /notify/i);
  const noParentDisabled = success(['send', noParentReturn.id, '--message', 'disable automatic return', '--no-return', '--wait']);
  assert.equal(noParentDisabled.autoReturn, false);
  assert.equal(noParentDisabled.error, undefined);
  const repairedId = 'repair-missing-parent';
  success(['create', '--id', repairedId, '--agent', 'returns', '--no-return']);
  const repaired = success(['send', repairedId, '--message', 'repair callback', '--wait'], { PI_SESSION_ID: 'main' });
  assert.equal(repaired.autoReturn, false);
  assert.equal(repaired.parentCallback.sessionId, 'main');
  const repairedNotices = listParentNotifications(config).filter(notice => notice.child?.id === repairedId);
  assert.equal(repairedNotices.length, 1);
  assert.equal(repairedNotices[0].type, 'session.return');
  const automatic = success(['send', repairedId, '--message', 'also complete', '--return', '--wait']);
  assert.equal(automatic.autoReturn, true);
  assert.equal(automatic.parentCallback.sessionId, 'main');
  assert.deepEqual(listParentNotifications(config).filter(notice => notice.child?.id === repairedId).map(notice => notice.type), ['session.return', 'session.return', 'session.completed']);

  const named = success(['create', '--id', 'named', '--agent', 'fast', '--prompt', 'first', '--wait']);
  assert.equal(named.agentProfile, 'fast');
  assert.equal(named.agentProfileSnapshot.backend, 'mock');
  assert.equal(named.lastResult, 'saved-profile: first');
  assert.equal(named.autoReturn, false);
  assert.equal(success(['status', 'named']).autoReturn, false);
  const listed = command(['list']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /^named\tcompleted\tfalse\t/m);
  assert.doesNotMatch(listed.stdout, /notify/i);
  for (const flag of ['--notify', '--no-notify']) {
    const id = `rejected-${flag.slice(2)}`;
    const rejectedCreate = command(['create', '--id', id, flag, '--prompt', 'must not run', '--wait'], { PI_SESSION_ID: 'main' });
    assert.equal(rejectedCreate.status, 2, rejectedCreate.stderr);
    assert.doesNotMatch(rejectedCreate.stderr, /notify/i, 'invalid old flags must not be advertised');
    assert.equal(rejectedCreate.stdout, '');
    assert.equal(loadRegistry(config).sessions[id], undefined, 'invalid flags must not create sessions');
    const beforeSend = getSession(config, 'named');
    const rejectedSend = command(['send', 'named', flag, '--message', 'must not run', '--wait']);
    assert.equal(rejectedSend.status, 2, rejectedSend.stderr);
    assert.equal(rejectedSend.stdout, '');
    assert.deepEqual(getSession(config, 'named'), beforeSend, 'invalid flags must not modify or execute existing sessions');
    for (const args of [['status', 'named', flag], ['history', 'named', flag], ['list', flag]]) {
      const rejectedRead = command(args);
      assert.equal(rejectedRead.status, 2, rejectedRead.stderr);
      assert.equal(rejectedRead.stdout, '');
    }
  }
  const duplicate = command(['create', '--id', 'named', '--agent', 'plain']);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /already exists/);
  assert.equal(getSession(config, 'named').agentProfile, 'fast');
  const unavailable = command(['create', '--id', 'bad-profile', '--agent', 'unknown']);
  assert.notEqual(unavailable.status, 0);
  assert.match(unavailable.stderr, /profile not found/);
  assert.equal(loadRegistry(config).sessions['bad-profile'], undefined);
  const changedConfig = { ...config, agent: { ...config.agent, mock: false }, agentProfiles: { ...config.agentProfiles, fast: { backend: 'process', command: '/changed/missing' } } };
  fs.writeFileSync(configPath, JSON.stringify(changedConfig));
  const repeated = success(['send', 'named', '--message', 'second', '--wait']);
  assert.equal(repeated.lastResult, 'saved-profile: second');
  const migration = command(['send', 'named', '--agent', 'plain', '--message', 'no']);
  assert.notEqual(migration.status, 0);
  assert.match(migration.stderr, /only supported by sessions create/);
  fs.writeFileSync(configPath, JSON.stringify(config));

  const asyncRecord = success(['create', '--id', 'async', '--agent', 'plain', '--prompt', 'original prompt']);
  assert.equal(asyncRecord.status, 'running');
  assert.ok(asyncRecord.pid);
  assert.ok(asyncRecord.watcherPid);
  assert.notEqual(asyncRecord.pid, asyncRecord.watcherPid, 'parent must not overwrite child pid with watcher pid');
  const files = fs.readdirSync(path.dirname(asyncRecord.logPath)).filter(name => name.endsWith('.prompt'));
  assert.deepEqual(files, [`async.${asyncRecord.runId}.prompt`]);
  const busy = command(['send', 'async', '--message', 'must not replace prompt', '--wait']);
  assert.notEqual(busy.status, 0);
  assert.match(busy.stderr, /busy|already running/);
  const asyncFinal = await settled('async');
  assert.equal(asyncFinal.status, 'completed');
  assert.equal(asyncFinal.pid, undefined);
  assert.equal(asyncFinal.watcherPid, undefined);
  assert.equal(asyncFinal.runId, undefined);
  assert.equal(asyncFinal.lastPrompt, 'original prompt');
  const reply = JSON.parse(asyncFinal.lastResult!.split('\n').find(line => line.startsWith('{'))!);
  assert.equal(reply.prompt, 'original prompt');
  assert.equal(reply.pid, asyncRecord.pid);
  assert.equal(reply.config, configPath);
  assert.equal(reply.path.split(path.delimiter)[0], path.join(project, 'dist'));
  assert.equal(reply.session, 'async');
  assert.equal(fs.readdirSync(path.dirname(asyncRecord.logPath)).some(name => name.endsWith('.prompt')), false);

  const sync = success(['create', '--id', 'sync', '--agent', 'plain', '--prompt', 'sync text', '--wait']);
  assert.equal(sync.status, 'completed');
  assert.match(sync.lastResult, /sync text/);
  const tokenSession = insertSession(config, selectSessionAgent(config, newSessionRecord(config, { id: 'token', autoReturn: false }), 'fast'));
  const oldRun = claimSessionRun(config, tokenSession, 'old');
  assert.ok(oldRun);
  finishSessionRun(config, 'token', 'old', { status: 'completed', lastResult: 'old output' });
  claimSessionRun(config, getSession(config, 'token'), 'new');
  assert.equal(updateSessionRun(config, 'token', 'old', { status: 'completed', lastResult: 'stale' }), undefined);
  finishSessionRun(config, 'token', 'old', { status: 'completed', lastResult: 'stale' });
  assert.equal(getSession(config, 'token').status, 'running');
  assert.equal(getSession(config, 'token').runId, 'new');
  finishSessionRun(config, 'token', 'new', { status: 'completed', lastResult: 'new output' });

  const missing = command(['create', '--id', 'missing', '--agent', 'absent', '--prompt', 'never', '--wait']);
  // Synchronous backend failure still returns the established record JSON shape.
  assert.equal(missing.status, 0, missing.stderr);
  const missingRecord = JSON.parse(missing.stdout);
  assert.equal(missingRecord.status, 'failed');
  assert.match(missingRecord.error, /ENOENT/);
  assert.match(fs.readFileSync(missingRecord.logPath, 'utf8'), /ENOENT/);
  const missingAsync = command(['create', '--id', 'missing-async', '--agent', 'absent', '--prompt', 'never']);
  assert.notEqual(missingAsync.status, 0);
  const missingAsyncRecord = getSession(config, 'missing-async');
  assert.equal(missingAsyncRecord.status, 'failed');
  assert.match(missingAsyncRecord.error!, /startup failed|ENOENT/);
  assert.match(fs.readFileSync(missingAsyncRecord.logPath, 'utf8'), /startup failed|ENOENT/);

  const timedSync = success(['create', '--id', 'timed-sync', '--agent', 'timeout', '--prompt', 'timeout', '--wait']);
  assert.equal(timedSync.status, 'failed');
  assert.match(timedSync.error, /timed out/);
  success(['create', '--id', 'timed-async', '--agent', 'timeout', '--prompt', 'timeout']);
  const timedAsync = await settled('timed-async');
  assert.equal(timedAsync.status, 'failed');
  assert.match(timedAsync.error!, /timed out/);

  const dead = putSession(config, { ...newSessionRecord(config, { id: 'lost-pid', autoReturn: false }), status: 'running', runId: 'lost', pid: 2147483647 });
  const lost = refreshSessionStatus(config, dead);
  assert.equal(lost.status, 'failed');
  assert.match(lost.error!, /interrupted|no successful result/);
  const staleSend = putSession(config, { ...selectSessionAgent(config, newSessionRecord(config, { id: 'stale-send', autoReturn: false }), 'fast'), status: 'running', runId: 'dead-run', pid: 2147483647, watcherPid: 2147483646 });
  const recoveredSend = await runSessionPrompt(config, staleSend, 'recovered without status first', true);
  assert.equal(recoveredSend.status, 'completed');
  assert.equal(recoveredSend.lastResult, 'saved-profile: recovered without status first');
  const staleCronTarget = putSession(config, { ...selectSessionAgent(config, newSessionRecord(config, { id: 'stale-cron', autoReturn: true }), 'fast'), status: 'running', runId: 'dead-cron-run', pid: 2147483647 });
  await dispatchRuntimeCron(config, makeRuntimeCron({ id: 'recover-fixed', prompt: 'cron recovered', schedule: { type: 'cron', expression: '* * * * *' }, target: 'session:stale-cron' }), async () => {});
  assert.equal(getSession(config, staleCronTarget.id).lastResult, 'saved-profile: cron recovered');
  assert.equal(getSession(config, staleCronTarget.id).autoReturn, false);

  for (const wait of [true, false]) {
    const id = `unicode-${wait}`;
    success(['create', '--id', id, '--agent', 'unicode', '--prompt', 'utf8', ...(wait ? ['--wait'] : [])]);
    const unicode = await settled(id);
    assert.equal(unicode.lastResult, '你好🙂');
    assert.match(fs.readFileSync(unicode.logPath, 'utf8'), /你好🙂/);
  }
  if (process.platform !== 'win32') {
    for (const wait of [true, false]) {
      const id = `tree-${wait}`;
      success(['create', '--id', id, '--agent', 'tree', '--prompt', 'descendant', ...(wait ? ['--wait'] : [])]);
      const tree = await settled(id);
      assert.equal(tree.status, 'failed');
      assert.match(tree.error!, /timed out/);
      const descendantPid = Number(fs.readFileSync(descendantPidFile, 'utf8'));
      const result = spawnSync('ps', ['-p', String(descendantPid), '-o', 'stat='], { encoding: 'utf8' });
      assert.ok(result.status !== 0 || !result.stdout.trim() || result.stdout.includes('Z'), 'timeout must terminate inherited-pipe descendant');
    }
  }

  const fixedCron = makeRuntimeCron({ id: 'fixed-profile', prompt: 'cron saved', schedule: { type: 'cron', expression: '* * * * *' }, target: 'session:named' });
  await dispatchRuntimeCron({ ...config, agent: { ...config.agent, mock: false }, agentProfiles: { fast: { backend: 'process', command: '/wrong' } } }, fixedCron, async () => {});
  assert.equal(getSession(config, 'named').lastResult, 'saved-profile: cron saved');
  const defaultCronConfig = { ...config, agent: { ...config.agent, profile: 'fast' } };
  const freshCron = makeRuntimeCron({ id: 'new-profile', prompt: 'cron new', schedule: { type: 'cron', expression: '* * * * *' }, target: 'new' });
  await dispatchRuntimeCron(defaultCronConfig, freshCron, async () => {});
  const fresh = Object.values(loadRegistry(config).sessions).find(record => record.name === 'cron:new-profile')!;
  assert.equal(fresh.agentProfile, 'fast');
  assert.equal(fresh.lastResult, 'saved-profile: cron new');

  for (const [id, schedule] of [
    ['interrupted-once', { type: 'at', at: new Date(Date.now() - 1000).toISOString() }],
    ['interrupted-recurring', { type: 'cron', expression: '* * * * *' }],
  ] as const) {
    putCron(config, makeRuntimeCron({ id, prompt: 'do not replay', schedule }));
    markRuntimeCronRunning(config, id);
  }
  let replayed = 0;
  const dispatcher = new RuntimeCronDispatcher(config, async () => { replayed++; });
  dispatcher.start();
  dispatcher.stop();
  assert.equal(replayed, 0);
  for (const id of ['interrupted-once', 'interrupted-recurring']) {
    const interrupted = getCron(config, id);
    assert.equal(interrupted.status, 'failed');
    assert.equal(interrupted.enabled, false);
    assert.equal(interrupted.nextRunAt, undefined);
    assert.match(interrupted.lastError!, /restart|replay|re-enable/);
  }
  assert.deepEqual(dueRuntimeCrons(config), []);
  const heldId = 'held-main-replacement';
  putCron(config, makeRuntimeCron({ id: heldId, prompt: 'old held event', schedule: { type: 'at', at: new Date(Date.now() - 1000).toISOString() }, target: 'main' }));
  let releaseHeld: (() => void) | undefined;
  const heldDispatcher = new RuntimeCronDispatcher(config, async () => { await new Promise<void>(resolve => { releaseHeld = resolve; }); });
  heldDispatcher.start();
  assert.ok(releaseHeld);
  const oldToken = getCron(config, heldId).runId;
  assert.ok(oldToken);
  deleteCron(config, heldId);
  const replacement = putCron(config, makeRuntimeCron({ id: heldId, prompt: 'new replacement', schedule: { type: 'at', at: new Date(Date.now() + 60_000).toISOString() }, target: 'main' }));
  releaseHeld!();
  await new Promise(resolve => setTimeout(resolve, 50));
  heldDispatcher.stop();
  assert.equal(getCron(config, heldId).prompt, 'new replacement');
  assert.equal(getCron(config, heldId).status, 'scheduled');
  assert.equal(getCron(config, heldId).enabled, true);
  assert.equal(getCron(config, heldId).nextRunAt, replacement.nextRunAt);
  console.log('sessions tests passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
