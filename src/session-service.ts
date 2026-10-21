import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolveAgentProfile, sessionAgentProcess, sessionAgentProfile, type AgentProcess } from './agents/index.js';
import { absoluteConfigPath, agentProcessEnv, sessionWatcherCommand } from './process-paths.js';
import { agentProcessDetached, agentProcessGroupAlive, signalAgentProcess, waitForAgentProcessExit } from './process-control.js';
import { appendSessionLog, claimSessionRun, finishSessionRunAndNotify, getSession, refreshSessionStatus, updateSessionRun, type PersonalSessionRecord } from './session-registry.js';
import type { AppConfig } from './types.js';

const STARTUP_TIMEOUT_MS = 10_000;

class SessionStartupError extends Error {
  constructor(message: string, readonly keepRunning: boolean) { super(message); }
}

async function stopFailedWatcher(config: AppConfig, record: PersonalSessionRecord, runId: string, watcher: ReturnType<typeof spawn> | undefined): Promise<boolean> {
  if (!watcher?.pid) return true;
  // Child harnesses own a separate group; stop them before their detached supervisor.
  const current = getSession(config, record.id);
  const childPid = current.runId === runId && current.pid !== watcher.pid ? current.pid : undefined;
  if (childPid) {
    const child = { pid: childPid } as ReturnType<typeof spawn>;
    if (!signalAgentProcess(child, 'SIGKILL') || !await waitForAgentProcessExit(child)) return false;
  }
  return signalAgentProcess(watcher, 'SIGKILL') && await waitForAgentProcessExit(watcher);
}

/** Save the resolved choice, not just a name which could later point to a different backend. */
export function selectSessionAgent(config: AppConfig, record: PersonalSessionRecord, requested?: string, cwd?: string): PersonalSessionRecord {
  const { name, profile } = resolveAgentProfile(config, requested);
  return {
    ...record,
    agentProfile: name,
    agentProfileSnapshot: profile,
    cwd: path.resolve(cwd || profile.cwd || record.cwd),
    sessionDir: profile.sessionDir,
  };
}

export async function runSessionPrompt(config: AppConfig, session: PersonalSessionRecord | string, prompt: string, wait: boolean): Promise<PersonalSessionRecord> {
  let original = typeof session === 'string' ? getSession(config, session) : session;
  if (original.status === 'running') {
    const { notify, parentCallback } = original;
    // A dead leader is not an empty process group: don't reclaim while its tools still run.
    const harnessGroupAlive = original.pid && agentProcessDetached && agentProcessGroupAlive({ pid: original.pid });
    if (!harnessGroupAlive) original = refreshSessionStatus(config, original);
    Object.assign(original, { notify, parentCallback });
  }
  const selected = sessionAgentProfile(config, original);
  const runId = randomUUID();
  const candidate = Object.assign(original, {
    agentProfile: selected.name,
    agentProfileSnapshot: selected.profile,
    lastPrompt: prompt,
    lastResult: undefined,
    error: undefined,
    exitCode: undefined,
    parentNotificationPath: undefined,
  });
  const record = claimSessionRun(config, candidate, runId);
  if (!record) throw new Error(`session is already running: ${original.id}`);
  try {
    appendSessionLog(record, `\n## ${new Date().toISOString()} prompt runId=${runId} agent=${selected.name} backend=${selected.profile.backend}\n${prompt}\n\n`);
    const spec = sessionAgentProcess(config, record, prompt);
    if (typeof spec === 'string') {
      appendSessionLog(record, spec + '\n');
      return finishSessionRun(config, record.id, runId, { status: 'completed', lastResult: spec, exitCode: 0 });
    }
    if (wait) return await executeSessionProcess(config, record, runId, spec, () => {});
    return await launchSessionWatcher(config, record, runId, prompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SessionStartupError && error.keepRunning) {
      appendSessionLog(record, `\n${message}; execution remains busy until process exit is confirmed\n`);
      updateSessionRun(config, record.id, runId, { error: message });
    } else {
      finishSessionRun(config, record.id, runId, { status: 'failed', error: message });
    }
    throw error;
  }
}

/** Only the holder of the active token may commit a terminal result or send its completion notice. */
export function finishSessionRun(config: AppConfig, id: string, runId: string, patch: Partial<PersonalSessionRecord>): PersonalSessionRecord {
  const current = getSession(config, id);
  if (current.runId !== runId || current.status !== 'running') return current;
  appendSessionLog(current, `\n## ${new Date().toISOString()} run finished runId=${runId} status=${patch.status} exitCode=${patch.exitCode ?? 'unknown'}${patch.error ? ` error=${patch.error}` : ''}\n`);
  return finishSessionRunAndNotify(config, id, runId, { ...patch, pid: undefined, watcherPid: undefined }) || getSession(config, id);
}

async function launchSessionWatcher(config: AppConfig, record: PersonalSessionRecord, runId: string, prompt: string): Promise<PersonalSessionRecord> {
  const promptFile = path.join(path.dirname(record.logPath), `${record.id}.${runId}.prompt`);
  fs.mkdirSync(path.dirname(promptFile), { recursive: true });
  fs.writeFileSync(promptFile, prompt, { flag: 'wx', mode: 0o600 });
  let watcher: ReturnType<typeof spawn> | undefined;
  let logFd: number | undefined;
  try {
    const command = sessionWatcherCommand();
    logFd = fs.openSync(record.logPath, 'a');
    watcher = spawn(process.execPath, [
      ...command.args,
      '--config', absoluteConfigPath(config), '--id', record.id, '--run-id', runId, '--prompt-file', promptFile,
    ], { cwd: record.cwd, detached: true, stdio: ['ignore', 'ignore', logFd, 'ipc'], env: agentProcessEnv(config, record) });
    fs.closeSync(logFd);
    logFd = undefined;
    const child = watcher;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => done(new Error('session watcher startup timed out')), STARTUP_TIMEOUT_MS);
      const done = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener('message', onMessage);
        child.removeListener('exit', onExit);
        error ? reject(error) : resolve();
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => done(new Error(`session watcher exited during startup code=${code} signal=${signal}`));
      const onMessage = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const message = value as { type?: string; error?: string };
        try {
          if (message.type === 'ready') {
            if (!child.pid || !updateSessionRun(config, record.id, runId, { pid: child.pid, watcherPid: child.pid })) {
              done(new Error('session run ownership lost before watcher launch'));
              return;
            }
            child.send({ type: 'launch', config }, error => { if (error) done(error); });
          } else if (message.type === 'launched') done();
          else if (message.type === 'failed') done(new Error(message.error || 'session watcher startup failed'));
        } catch (error) {
          done(error instanceof Error ? error : new Error(String(error)));
        }
      };
      child.on('message', onMessage);
      child.once('error', error => done(new Error(`session watcher startup failed: ${error.message}`)));
      child.once('exit', onExit);
    });
    if (watcher.connected) watcher.disconnect();
    watcher.unref();
    return getSession(config, record.id);
  } catch (error) {
    const stopped = await stopFailedWatcher(config, record, runId, watcher);
    if (watcher?.connected) watcher.disconnect();
    watcher?.unref();
    if (stopped && fs.existsSync(promptFile)) fs.unlinkSync(promptFile);
    throw new SessionStartupError(error instanceof Error ? error.message : String(error), !stopped);
  } finally {
    if (logFd !== undefined) fs.closeSync(logFd);
  }
}

async function executeSessionProcess(config: AppConfig, record: PersonalSessionRecord, runId: string, spec: AgentProcess, onStarted: () => void): Promise<PersonalSessionRecord> {
  let child: ReturnType<typeof spawn> | undefined;
  let deadlineTimer: NodeJS.Timeout | undefined;
  let executionError: string | undefined;
  const terminate = () => {
    executionError ||= 'agent execution interrupted';
    if (child) signalAgentProcess(child, 'SIGKILL');
  };
  process.once('SIGTERM', terminate);
  try {
    let output = '';
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child = spawn(spec.command, spec.args, { cwd: record.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: spec.env, detached: agentProcessDetached });
      if (spec.timeoutMs) deadlineTimer = setTimeout(() => {
        executionError = 'timed out waiting for process agent';
        terminate();
      }, spec.timeoutMs);
      child.stdout!.setEncoding('utf8');
      child.stderr!.setEncoding('utf8');
      const collect = (chunk: string) => { appendSessionLog(record, chunk); output = (output + chunk).slice(-4000); };
      child.stdout!.on('data', collect);
      child.stderr!.on('data', collect);
      child.once('error', error => { executionError = `agent startup failed: ${error.message}`; });
      child.stdin!.on('error', error => { executionError = `agent stdin failed: ${error.message}`; terminate(); });
      const outputError = (error: Error) => { executionError = `agent output failed: ${error.message}`; terminate(); };
      child.stdout!.on('error', outputError);
      child.stderr!.on('error', outputError);
      child.once('spawn', () => {
        try {
          if (!updateSessionRun(config, record.id, runId, { pid: child!.pid })) throw new Error('session run ownership lost after agent startup');
          onStarted();
          child!.stdin!.end(spec.stdin);
        } catch (error) {
          executionError = error instanceof Error ? error.message : String(error);
          terminate();
        }
      });
      child.once('exit', () => {
        if (agentProcessGroupAlive(child!)) {
          executionError ||= 'agent exited with descendant processes still running';
          terminate();
        } else signalAgentProcess(child!, 'SIGKILL');
      });
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    if (deadlineTimer) clearTimeout(deadlineTimer);
    signalAgentProcess(child!, 'SIGKILL');
    if (!await waitForAgentProcessExit(child!)) throw new SessionStartupError('agent termination could not be confirmed', true);
    const error = executionError || (result.signal ? `agent terminated by ${result.signal}` : result.code === 0 ? undefined : `agent exited code=${result.code}`);
    return finishSessionRun(config, record.id, runId, { status: result.code === 0 && !error ? 'completed' : 'failed', exitCode: result.code, error, lastResult: output.trim() });
  } finally {
    process.removeListener('SIGTERM', terminate);
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

/** Watcher and --wait share the same process-group teardown and guarded completion. */
export async function executeSessionRun(config: AppConfig, id: string, runId: string, promptFile: string, onStarted: () => void): Promise<void> {
  try {
    const record = getSession(config, id);
    if (record.runId !== runId || record.status !== 'running') throw new Error('session run ownership lost before execution');
    const spec = sessionAgentProcess(config, record, fs.readFileSync(promptFile, 'utf8'));
    if (typeof spec === 'string') {
      onStarted();
      appendSessionLog(record, spec + '\n');
      finishSessionRun(config, id, runId, { status: 'completed', exitCode: 0, lastResult: spec });
    } else {
      const finished = await executeSessionProcess(config, record, runId, spec, onStarted);
      if (finished.status === 'failed') throw new Error(finished.error || 'agent execution failed');
    }
  } catch (error) {
    if (error instanceof SessionStartupError && error.keepRunning) updateSessionRun(config, id, runId, { error: error.message });
    else finishSessionRun(config, id, runId, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    if (fs.existsSync(promptFile)) fs.unlinkSync(promptFile);
  }
}
