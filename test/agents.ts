import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/extensions/index.js';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import {
  createMainAgentRunner,
  resolveAgentProfile,
  sessionAgentProcess,
} from '../src/core/agents/registry.js';
import {
  absoluteConfigPath,
  agentProcessEnv,
  helperBinDirectory,
} from '../src/core/runtime/process-paths.js';
import { newSessionRecord } from '../src/core/sessions/registry.js';
import { selectSessionAgent } from '../src/core/sessions/service.js';
import { PiRpcRunner } from '../src/extensions/pi/runner.js';
import type { AppConfig, ProcessAgentProfile } from '../src/types.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retriever-agents-'));
const originalConfigEnv = process.env.RETRIEVER_CONFIG;
try {
  const config: AppConfig = {
    workspaceDir: tmp,
    agentProfiles: {
      fake: { backend: 'mock', replyPrefix: 'profile reply: ' },
      pi: { backend: 'pi', bin: '/profile/pi', extraArgs: ['--own'] },
      text: {
        backend: 'process',
        command: process.execPath,
        args: [
          '-e',
          'process.stdin.setEncoding("utf8");let text="";process.stdin.on("data",c=>text+=c);process.stdin.on("end",()=>process.stdout.write("plain:"+text));',
        ],
      },
    },
    sender: { type: 'mock', mockOutbox: path.join(tmp, 'outbox') },
    extensions: {
      pi: { bin: '/global/pi', extraArgs: ['--global'] },
      feishu: { appId: '', appSecret: '' },
    },
    stateDir: path.join(tmp, 'state'),
    configPath: path.join(tmp, 'config.json'),
  };
  assert.equal(resolveAgentProfile(config).profile.backend, 'pi');
  assert.equal(resolveAgentProfile(config, 'pi').profile.backend, 'pi');
  assert.throws(() => resolveAgentProfile(config, 'missing'), /profile not found/);
  assert.throws(
    () =>
      resolveAgentProfile(
        { ...config, agentProfiles: { bad: { backend: 'unknown' } as never } },
        'bad',
      ),
    /unsupported agent backend/,
  );
  // Pi's RPC runner keeps a mock mode for tests; user config never reaches it.
  const legacyMain = new PiRpcRunner(config, { mock: true });
  assert.equal(await legacyMain.promptAndWait('legacy'), 'mock pi reply: legacy');
  assert.deepEqual(await legacyMain.getContextUsage(), {
    text: 'Context usage unavailable',
    source: 'pi-rpc context usage unavailable',
  });
  legacyMain.close();

  const namedMain = createMainAgentRunner({
    ...config,
    agentProfiles: { default: { backend: 'mock', replyPrefix: 'profile reply: ' } },
  });
  assert.equal(await namedMain.promptAndWait('named'), 'profile reply: named');
  assert.equal(namedMain.capabilities.contextUsage, false);
  await assert.rejects(namedMain.getMessages(), /does not support native history/);
  await assert.rejects(namedMain.steer('unsupported'), /does not support steer/);
  namedMain.close();

  const record = selectSessionAgent(
    config,
    newSessionRecord(config, { id: 'snapshot', autoReturn: false }),
    'pi',
  );
  config.agentProfiles!.pi = { backend: 'mock', replyPrefix: 'changed' };
  config.extensions.pi.bin = '/changed/global';
  const spec = sessionAgentProcess(config, record, 'prompt');
  assert.notEqual(typeof spec, 'string');
  if (typeof spec !== 'string') {
    assert.equal(spec.command, '/profile/pi');
    assert.deepEqual(spec.args, [
      '--print',
      '--session-id',
      'snapshot',
      '--approve',
      'prompt',
      '--own',
    ]);
    assert.doesNotMatch(JSON.stringify(spec.args), /global/);
  }

  const processMain = createMainAgentRunner({
    ...config,
    agentProfiles: { ...config.agentProfiles, default: config.agentProfiles!.text },
  });
  assert.deepEqual(processMain.capabilities, {
    prompt: true,
    steer: false,
    history: false,
    contextUsage: false,
  });
  processMain.start();
  const task = processMain.promptAndWait('hello with spaces');
  assert.equal(processMain.isRunning(), true);
  await assert.rejects(processMain.promptAndWait('overlap'), /already running/);
  await processMain.waitForSettled();
  assert.equal(await task, 'plain:hello with spaces');
  assert.equal(processMain.isRunning(), false);
  await assert.rejects(processMain.steer('no'), /does not support steer/);
  await assert.rejects(processMain.getMessages(), /does not support native history/);
  assert.match((await processMain.getContextUsage()).source, /does not support context usage/);
  processMain.close();

  const hangingProfile: ProcessAgentProfile = {
    backend: 'process',
    command: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    timeoutMs: 50,
  };
  const timeoutRunner = createMainAgentRunner({
    ...config,
    agentProfiles: { default: hangingProfile },
  });
  const timeoutStart = Date.now();
  await assert.rejects(timeoutRunner.promptAndWait('hang'), /timed out/);
  assert.ok(Date.now() - timeoutStart < 1000);
  assert.equal(timeoutRunner.isRunning(), true, 'uncertain process stays busy until close');
  await assert.rejects(timeoutRunner.promptAndWait('cannot overlap'), /running or stopping/);
  const exitDeadline = Date.now() + 2000;
  while (timeoutRunner.isRunning() && Date.now() < exitDeadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(timeoutRunner.isRunning(), false);
  timeoutRunner.close();
  const closeRunner = createMainAgentRunner({
    ...config,
    agentProfiles: { default: { ...hangingProfile, timeoutMs: 1000 } },
  });
  const closing = closeRunner.promptAndWait('close');
  const rejectsClose = assert.rejects(closing, /runner closed/);
  closeRunner.close();
  await rejectsClose;
  await assert.rejects(closeRunner.promptAndWait('after close'), /is closed/);

  const stdinRunner = createMainAgentRunner({
    ...config,
    agentProfiles: {
      default: {
        backend: 'process',
        command: process.execPath,
        args: ['-e', 'require("node:fs").closeSync(0);setInterval(()=>{},1000)'],
        timeoutMs: 1000,
      },
    },
  });
  await assert.rejects(stdinRunner.promptAndWait('x'.repeat(4_000_000)), /stdin failed/);
  assert.equal(stdinRunner.isRunning(), true);
  await assert.rejects(stdinRunner.promptAndWait('no orphan overlap'), /running or stopping/);
  const stdinDeadline = Date.now() + 2000;
  while (stdinRunner.isRunning() && Date.now() < stdinDeadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stdinRunner.isRunning(), false);
  stdinRunner.close();

  if (process.platform !== 'win32') {
    const descendantFile = path.join(tmp, 'descendant.pid');
    const descendantCode = `require('node:fs').writeFileSync(${JSON.stringify(descendantFile)},String(process.pid));setInterval(()=>{},1000);`;
    const treeArgs = [
      '-e',
      `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:['ignore',1,2]});setInterval(()=>{},1000);`,
    ];
    const treeRunner = createMainAgentRunner({
      ...config,
      agentProfiles: {
        default: { backend: 'process', command: process.execPath, args: treeArgs, timeoutMs: 200 },
      },
    });
    try {
      await assert.rejects(treeRunner.promptAndWait('tree timeout'), /timed out/);
      const deadline = Date.now() + 2000;
      while (treeRunner.isRunning() && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(
        treeRunner.isRunning(),
        false,
        'same-group descendant must not hold pipes open after timeout',
      );
      const pid = Number(fs.readFileSync(descendantFile, 'utf8'));
      const state = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' });
      assert.ok(
        state.status !== 0 || !state.stdout.trim() || state.stdout.includes('Z'),
        'descendant must be terminated',
      );
      const exitRunner = createMainAgentRunner({
        ...config,
        agentProfiles: {
          default: {
            backend: 'process',
            command: process.execPath,
            args: [
              '-e',
              `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:['ignore',1,2]});setTimeout(()=>process.exit(0),100);`,
            ],
            timeoutMs: 1000,
          },
        },
      });
      await assert.rejects(exitRunner.promptAndWait('leader exits'), /descendant processes/);
      const exitTreeDeadline = Date.now() + 2000;
      while (exitRunner.isRunning() && Date.now() < exitTreeDeadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(exitRunner.isRunning(), false);
      exitRunner.close();
    } finally {
      treeRunner.close();
      if (fs.existsSync(descendantFile)) {
        try {
          process.kill(Number(fs.readFileSync(descendantFile, 'utf8')), 'SIGKILL');
        } catch {}
      }
    }
  }
  const unicodeRunner = createMainAgentRunner({
    ...config,
    agentProfiles: {
      default: {
        backend: 'process',
        command: process.execPath,
        args: [
          '-e',
          `const bytes=Buffer.from('你好🙂');let i=0;const timer=setInterval(()=>{process.stdout.write(bytes.subarray(i,i+1));if(++i===bytes.length)clearInterval(timer);},5);`,
        ],
      },
    },
  });
  assert.equal(await unicodeRunner.promptAndWait('unicode'), '你好🙂');
  unicodeRunner.close();

  const legacyRecord = {
    ...newSessionRecord(config, { id: 'legacy', autoReturn: false }),
    cwd: path.join(tmp, 'old-cwd'),
    sessionDir: path.join(tmp, 'old-sessions'),
  };
  const legacyConfig: AppConfig = {
    ...config,
    extensions: {
      ...config.extensions,
      pi: { bin: '/legacy/pi', extraArgs: ['--legacy'] },
    },
    agentProfiles: {
      default: { backend: 'process', command: '/wrong-default' } as ProcessAgentProfile,
      'new-main': { backend: 'process', command: '/wrong-main' } as ProcessAgentProfile,
    },
  };
  // Imported sessions keep the recorded workspace and ignore the current default profile.
  const legacySpec = sessionAgentProcess(legacyConfig, legacyRecord, 'old history');
  if (typeof legacySpec === 'string') throw new Error('legacy Pi record incorrectly selected mock');
  assert.equal(legacySpec.command, '/legacy/pi');
  assert.deepEqual(legacySpec.args, [
    '--print',
    '--session-id',
    'legacy',
    '--session-dir',
    legacyRecord.sessionDir,
    '--approve',
    'old history',
    '--legacy',
  ]);

  const fakePi = path.join(tmp, 'silent-pi');
  fs.writeFileSync(
    fakePi,
    `#!/usr/bin/env node\nprocess.stdin.resume();setInterval(()=>{},1000);\n`,
    { mode: 0o755 },
  );
  const piDeadlineRunner = createMainAgentRunner({
    ...config,
    agentProfiles: { default: { backend: 'pi', bin: fakePi, timeoutMs: 40 } },
  });
  const piStart = Date.now();
  await assert.rejects(piDeadlineRunner.getState(), /timed out|timeout/);
  assert.ok(Date.now() - piStart < 1000);
  piDeadlineRunner.close();

  const argumentProfile: ProcessAgentProfile = {
    backend: 'process',
    command: process.execPath,
    promptMode: 'argument',
    args: ['--task={prompt}', '--id={sessionId}'],
  };
  const argumentConfig = { ...config, agentProfiles: { arg: argumentProfile } };
  const argument = sessionAgentProcess(
    argumentConfig,
    selectSessionAgent(
      argumentConfig,
      newSessionRecord(config, { id: 'arg-session', autoReturn: false }),
      'arg',
    ),
    'a\n" b',
  );
  if (typeof argument === 'string') throw new Error('unexpected mock');
  assert.deepEqual(argument.args, ['--task=a\n" b', '--id=arg-session']);
  assert.equal(argument.stdin, undefined);
  assert.equal(argument.args.includes('--print'), false);

  const missingRunner = createMainAgentRunner({
    ...config,
    agentProfiles: {
      default: { backend: 'process', command: path.join(tmp, 'does-not-exist') },
    },
  });
  await assert.rejects(missingRunner.promptAndWait('no real calls'), /startup failed/);
  assert.equal(missingRunner.isRunning(), false);
  missingRunner.close();

  const configPath = path.join(tmp, 'relative-config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ...config,
      workspaceDir: './work',
      channel: { type: 'stdin' },
      stateDir: './state',
    }),
  );
  process.env.RETRIEVER_CONFIG = configPath;
  const loaded = loadConfig();
  assert.equal(loaded.channel?.type, 'stdin');
  assert.equal(loaded.workspaceDir, path.join(tmp, 'work'));
  assert.equal(loaded.stateDir, path.join(tmp, 'state'));
  assert.equal(absoluteConfigPath(loaded), configPath);
  assert.equal(agentProcessEnv(loaded).RETRIEVER_CONFIG, configPath);
  assert.ok(path.isAbsolute(helperBinDirectory()));
  assert.equal(agentProcessEnv(loaded).PATH?.split(path.delimiter)[0], helperBinDirectory());
  console.log('agents tests passed');
} finally {
  if (originalConfigEnv === undefined) delete process.env.RETRIEVER_CONFIG;
  else process.env.RETRIEVER_CONFIG = originalConfigEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
}
