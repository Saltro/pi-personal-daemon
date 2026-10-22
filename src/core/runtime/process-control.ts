import { type ChildProcess, spawnSync } from 'node:child_process';

/** Each harness owns a Unix process group so cancellation includes inherited-pipe descendants. */
export const agentProcessDetached = process.platform !== 'win32';

export function signalAgentProcess(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (agentProcessDetached && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      console.error(
        `[agent-process] process group signal failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
  if (!child.pid) return true;
  try {
    return child.kill(signal);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

export function agentProcessGroupAlive(child: Pick<ChildProcess, 'pid'>): boolean {
  if (!child.pid) return false;
  if (!agentProcessDetached) {
    try {
      process.kill(child.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }
  const result = spawnSync('ps', ['-A', '-o', 'pgid=', '-o', 'stat='], { encoding: 'utf8' });
  if (result.status !== 0) return true;
  return result.stdout.split('\n').some((line) => {
    const fields = line.trim().split(/\s+/);
    return Number(fields[0]) === child.pid && Boolean(fields[1]) && !fields[1].includes('Z');
  });
}

/** Confirm cancellation without releasing a run whose process group is still alive. */
export async function waitForAgentProcessExit(
  child: ChildProcess,
  timeoutMs = 1500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (agentProcessGroupAlive(child)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}
