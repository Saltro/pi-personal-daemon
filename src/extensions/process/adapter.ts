import { type ChildProcess, spawn } from 'node:child_process';
import {
  type AgentAdapter,
  type AgentProcess,
  type AgentRunner,
  unsupportedCapability,
} from '../../core/agents/types.js';
import {
  agentProcessDetached,
  agentProcessGroupAlive,
  signalAgentProcess,
  waitForAgentProcessExit,
} from '../../core/runtime/process-control.js';
import { agentProcessEnv } from '../../core/runtime/process-paths.js';
import type { PersonalSessionRecord } from '../../core/sessions/registry.js';
import type { AppConfig, ProcessAgentProfile } from '../../types.js';

export const processCapabilities = {
  prompt: true,
  steer: false,
  history: false,
  contextUsage: false,
};

export function processPrompt(
  config: AppConfig,
  profile: ProcessAgentProfile,
  record: PersonalSessionRecord | undefined,
  prompt: string,
): AgentProcess {
  const sessionId = record?.sessionId || config.agent.sessionId;
  const args = (profile.args || []).map((value) => value.replaceAll('{sessionId}', sessionId));
  if (profile.promptMode === 'argument') {
    let included = false;
    for (let i = 0; i < args.length; i++) {
      if (!args[i].includes('{prompt}')) continue;
      included = true;
      args[i] = args[i].replaceAll('{prompt}', prompt);
    }
    if (!included) args.push(prompt);
  } else if (args.some((value) => value.includes('{prompt}'))) {
    throw new Error('process agent {prompt} arguments require promptMode="argument"');
  }
  return {
    command: profile.command,
    args,
    stdin: profile.promptMode === 'argument' ? undefined : prompt,
    timeoutMs: profile.timeoutMs,
    env: agentProcessEnv(config, record, profile.env),
  };
}

class ProcessAgentRunner implements AgentRunner {
  readonly capabilities = processCapabilities;
  private child: ChildProcess | null = null;
  private active: Promise<string> | null = null;
  private stopActive: ((error: Error) => void) | null = null;
  private closed = false;

  constructor(
    private config: AppConfig,
    private profile: ProcessAgentProfile,
  ) {}

  start(): void {
    this.closed = false;
  }
  isRunning(): boolean {
    return this.child !== null || this.active !== null;
  }

  promptAndWait(message: string): Promise<string> {
    if (this.closed) return Promise.reject(new Error('process agent runner is closed'));
    if (this.isRunning())
      return Promise.reject(new Error('process agent is already running or stopping'));
    const spec = processPrompt(this.config, this.profile, undefined, message);
    const task = new Promise<string>((resolve, reject) => {
      const child = spawn(spec.command, spec.args, {
        cwd: this.profile.cwd || this.config.agent.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: spec.env,
        detached: agentProcessDetached,
      });
      this.child = child;
      let output = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(
        () => stop(new Error('timed out waiting for process agent')),
        spec.timeoutMs ?? 10 * 60 * 1000,
      );
      const stop = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
        // Rejection is not proof of exit. Keep the runner busy until close confirms termination.
        signalAgentProcess(child, 'SIGKILL');
        if (child.pid == null && this.child === child) this.child = null;
      };
      this.stopActive = stop;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        output = (output + String(chunk)).slice(-4000);
      });
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + String(chunk)).slice(-4000);
        process.stderr.write(`[agent-process] ${chunk}`);
      });
      child.on('error', (error) =>
        stop(new Error(`process agent startup failed: ${error.message}`)),
      );
      child.stdin.on('error', (error) =>
        stop(new Error(`process agent stdin failed: ${error.message}`)),
      );
      child.stdout.on('error', (error) => stop(error));
      child.stderr.on('error', (error) => stop(error));
      child.on('exit', () => {
        // A leader may exit before its descendants close inherited stdout/stderr.
        if (agentProcessGroupAlive(child))
          stop(new Error('process agent exited with descendant processes still running'));
        else signalAgentProcess(child, 'SIGKILL');
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        signalAgentProcess(child, 'SIGKILL');
        void waitForAgentProcessExit(child).then((stopped) => {
          if (stopped && this.child === child) {
            this.child = null;
            this.stopActive = null;
          }
          if (settled) return;
          settled = true;
          if (!stopped)
            reject(
              new Error('process agent termination could not be confirmed; runner remains busy'),
            );
          else
            code === 0
              ? resolve(output.trim())
              : reject(
                  new Error(
                    `process agent exited code=${code} signal=${signal}${stderr ? `: ${stderr.trim()}` : ''}`,
                  ),
                );
        });
      });
      child.stdin.end(spec.stdin);
    });
    const active = task.finally(() => {
      if (this.active === active) this.active = null;
    });
    this.active = active;
    return active;
  }

  async waitForSettled(timeoutMs = 10 * 60 * 1000): Promise<void> {
    const active = this.active;
    if (!active) {
      if (this.child) throw new Error('process agent is stopping; exit is not confirmed');
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        active,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error('timed out waiting for process agent');
            this.stopActive?.(error);
            reject(error);
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  steer(_message: string): ReturnType<AgentRunner['steer']> {
    return Promise.reject(unsupportedCapability('process', 'steer'));
  }
  getState(): Promise<unknown> {
    return Promise.resolve({ backend: 'process', isRunning: this.isRunning() });
  }
  getMessages(): Promise<unknown> {
    return Promise.reject(unsupportedCapability('process', 'native history'));
  }
  getContextUsage(): ReturnType<AgentRunner['getContextUsage']> {
    return Promise.resolve({
      text: 'Context usage unavailable',
      source: 'process backend does not support context usage',
    });
  }
  close(): void {
    this.closed = true;
    this.stopActive?.(new Error('process agent runner closed'));
  }
}

export const processAdapter: AgentAdapter = {
  sessionCapabilities: processCapabilities,
  createMainRunner(config, profile) {
    if (profile.backend !== 'process') throw new Error('invalid process agent profile');
    return new ProcessAgentRunner(config, profile);
  },
  sessionProcess(config, profile, record, prompt) {
    if (profile.backend !== 'process') throw new Error('invalid process agent profile');
    return processPrompt(config, profile, record, prompt);
  },
};
