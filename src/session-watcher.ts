#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { notifySessionCompletion } from './session-notifier.js';
import { appendSessionLog, getSession, putSession, type PersonalSessionRecord } from './session-registry.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function processState(pid: number): 'alive' | 'zombie' | 'gone' {
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' });
  if (ps.status !== 0 || !ps.stdout.trim()) return 'gone';
  return ps.stdout.includes('Z') ? 'zombie' : 'alive';
}

function piArgs(config: ReturnType<typeof loadConfig>, record: PersonalSessionRecord, prompt: string): string[] {
  return [
    '--print',
    '--session-id', record.sessionId,
    ...(record.sessionDir ? ['--session-dir', record.sessionDir] : []),
    '--approve',
    prompt,
    ...(config.agent.extraArgs || []),
  ];
}

function childEnv(record?: PersonalSessionRecord): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${process.cwd()}/dist:${process.env.PATH || ''}`,
    ...(record ? sessionEnv(record) : {}),
  };
}

function sessionEnv(record: PersonalSessionRecord): NodeJS.ProcessEnv {
  return {
    PI_PERSONAL_SESSION_ID: record.id,
    ...(record.parentCallback ? { PI_PERSONAL_PARENT_CALLBACK: JSON.stringify(record.parentCallback) } : {}),
  };
}

async function main(): Promise<void> {
  const configPath = arg('--config');
  if (configPath) process.env.PERSONAL_DAEMON_CONFIG = configPath;
  const id = arg('--id');
  const promptFile = arg('--prompt-file');
  const pidArg = Number(arg('--pid'));
  if (!id) throw new Error('Usage: session-watcher --config <path> --id <id> [--prompt-file <path> | --pid <pid>]');

  const config = loadConfig();
  let record = getSession(config, id);

  if (promptFile) {
    const prompt = fs.readFileSync(promptFile, 'utf8');
    const logFd = fs.openSync(record.logPath, 'a');
    const child = spawn(config.agent.piBin, piArgs(config, record, prompt), {
      cwd: record.cwd,
      stdio: ['ignore', logFd, logFd],
      env: childEnv(record),
    });
    record.pid = child.pid;
    record = putSession(config, record);
    const exitCode = await new Promise<number | null>(resolve => child.on('close', code => resolve(code)));
    fs.closeSync(logFd);
    if (fs.existsSync(promptFile)) fs.unlinkSync(promptFile);
    record = getSession(config, id);
    record.exitCode = exitCode;
    record.status = exitCode === 0 ? 'completed' : 'failed';
    record.pid = undefined;
    if (fs.existsSync(record.logPath)) record.lastResult = fs.readFileSync(record.logPath, 'utf8').trim().slice(-4000);
    appendSessionLog(record, `\n## ${new Date().toISOString()} watcher completed exitCode=${exitCode}\n`);
    record = putSession(config, record);
    await notifySessionCompletion(config, record);
    return;
  }

  if (!pidArg) throw new Error('Usage: session-watcher --config <path> --id <id> [--prompt-file <path> | --pid <pid>]');
  while (processState(pidArg) === 'alive') await new Promise(resolve => setTimeout(resolve, 2000));

  record = getSession(config, id);
  record.status = record.status === 'running' ? 'completed' : record.status;
  record.pid = undefined;
  if (fs.existsSync(record.logPath)) record.lastResult = fs.readFileSync(record.logPath, 'utf8').trim().slice(-4000);
  appendSessionLog(record, `\n## ${new Date().toISOString()} watcher completed pid=${pidArg}\n`);
  record = putSession(config, record);
  await notifySessionCompletion(config, record);
}

main().catch(error => {
  console.error(`[session-watcher] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
