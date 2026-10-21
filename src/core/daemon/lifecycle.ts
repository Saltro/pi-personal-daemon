import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../state/paths.js';
import type { AppConfig } from '../../types.js';

interface DaemonPidFile {
  pid: number;
  startedAt: string;
}

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  startedAt?: string;
  stalePid?: number;
  stateDir: string;
  pidPath: string;
  logPath: string;
}

export function daemonPidPath(config: AppConfig): string {
  return path.join(stateDir(config), 'daemon.pid');
}

export function daemonLogPath(config: AppConfig): string {
  return path.join(stateDir(config), 'daemon.log');
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readDaemonPid(config: AppConfig): DaemonPidFile | undefined {
  const file = daemonPidPath(config);
  if (!fs.existsSync(file)) return undefined;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DaemonPidFile>;
    if (!Number.isInteger(value.pid) || value.pid! <= 0) throw new Error('invalid pid');
    return { pid: value.pid!, startedAt: typeof value.startedAt === 'string' ? value.startedAt : '' };
  } catch (error) {
    throw new Error(`malformed daemon pid file ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function writeDaemonPid(config: AppConfig): DaemonPidFile {
  const record: DaemonPidFile = { pid: process.pid, startedAt: new Date().toISOString() };
  fs.mkdirSync(stateDir(config), { recursive: true });
  fs.writeFileSync(daemonPidPath(config), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  return record;
}

/** Remove the pid file only when it still describes this process or the observed pid. */
export function removeDaemonPid(config: AppConfig, pid?: number): void {
  const file = daemonPidPath(config);
  try {
    const current = readDaemonPid(config);
    if (!current || (pid !== undefined && current.pid !== pid)) return;
    fs.unlinkSync(file);
  } catch {
    fs.rmSync(file, { force: true });
  }
}

export function daemonStatus(config: AppConfig): DaemonStatus {
  const base = { stateDir: stateDir(config), pidPath: daemonPidPath(config), logPath: daemonLogPath(config) };
  const record = readDaemonPid(config);
  if (!record) return { running: false, ...base };
  if (!isProcessAlive(record.pid)) return { running: false, stalePid: record.pid, ...base };
  return { running: true, pid: record.pid, startedAt: record.startedAt, ...base };
}

export async function stopDaemon(config: AppConfig, timeoutMs = 10_000): Promise<DaemonStatus> {
  const status = daemonStatus(config);
  if (!status.running || !status.pid) throw new Error('daemon is not running');
  const { pid } = status;
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      removeDaemonPid(config, pid);
      return { ...status, running: false };
    }
    await delay(100);
  }
  throw new Error(`daemon pid ${pid} did not exit within ${timeoutMs}ms; inspect ${status.logPath}`);
}

export async function waitForDaemonStart(config: AppConfig, timeoutMs = 10_000): Promise<DaemonStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = daemonStatus(config);
    if (status.running) return status;
    await delay(100);
  }
  throw new Error(`daemon did not report a live pid within ${timeoutMs}ms; inspect ${daemonLogPath(config)}`);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
