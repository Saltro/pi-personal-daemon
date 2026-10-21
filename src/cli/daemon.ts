import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { loadConfig } from '../config.js';
import { daemonLogPath, daemonStatus, removeDaemonPid, stopDaemon, waitForDaemonStart, type DaemonStatus } from '../core/daemon/lifecycle.js';
import { selfCommand } from '../core/runtime/process-paths.js';
import { stateDir } from '../core/state/paths.js';
import type { AppConfig } from '../types.js';

function usage(): never {
  console.error(`Usage:
  pi-personal-daemon daemon start
  pi-personal-daemon daemon stop
  pi-personal-daemon daemon restart
  pi-personal-daemon daemon status`);
  process.exit(2);
}

export async function runDaemonCli(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (rest.length) usage();
  const config = loadConfig();

  if (command === 'start') {
    console.log(JSON.stringify(await launchDaemon(config), null, 2));
    return;
  }

  if (command === 'stop') {
    console.log(JSON.stringify(await stopDaemon(config), null, 2));
    return;
  }

  if (command === 'restart') {
    const existing = daemonStatus(config);
    if (existing.running) await stopDaemon(config);
    else removeDaemonPid(config, existing.stalePid);
    console.log(JSON.stringify(await launchDaemon(config), null, 2));
    return;
  }

  if (command === 'status') {
    const status = daemonStatus(config);
    if (!status.running && status.stalePid) removeDaemonPid(config, status.stalePid);
    console.log(JSON.stringify(status, null, 2));
    if (!status.running) process.exitCode = 1;
    return;
  }

  usage();
}

async function launchDaemon(config: AppConfig): Promise<DaemonStatus> {
  const existing = daemonStatus(config);
  if (existing.running) throw new Error(`daemon already running pid ${existing.pid}`);
  fs.mkdirSync(stateDir(config), { recursive: true });
  const logFd = fs.openSync(daemonLogPath(config), 'a', 0o600);
  const launch = selfCommand([]);
  const child = spawn(launch.command, launch.args, {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);
  child.unref();
  return waitForDaemonStart(config);
}
