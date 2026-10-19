import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import type { AgentConfig, AppConfig } from './types.js';

interface RpcResponse<T = unknown> {
  id?: string;
  type: 'response';
  command: string;
  success: boolean;
  data?: T;
  error?: string;
}

interface PromptResponse {
  disposition: 'started' | 'queued' | 'handled';
}

interface LastAssistantTextResponse {
  text: string | null;
}

interface PendingCommand {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

export class PiRpcRunner {
  private config: AgentConfig;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<string, PendingCommand>();
  private waiters: Waiter[] = [];
  private lastAssistantText = '';
  private running = false;

  constructor(config: AppConfig) {
    this.config = config.agent;
  }

  start(): void {
    if (this.config.mock) return;
    if (this.proc) return;
    const args = [
      '--mode', 'rpc',
      '--session-id', this.config.sessionId,
      ...(this.config.sessionDir ? ['--session-dir', this.config.sessionDir] : []),
      ...(this.config.extraArgs || []),
    ];
    this.proc = spawn(this.config.piBin, args, {
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PERSONAL_DAEMON_CONFIG: process.env.PERSONAL_DAEMON_CONFIG || `${process.cwd()}/config.json`,
        PATH: `${process.cwd()}/dist:${process.env.PATH || ''}`,
      },
    });
    this.proc.stderr.on('data', chunk => process.stderr.write(`[pi] ${chunk}`));
    this.proc.on('exit', (code, signal) => {
      const err = new Error(`pi rpc exited code=${code} signal=${signal}`);
      for (const pending of this.pending.values()) pending.reject(err);
      this.pending.clear();
      this.proc = null;
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', line => this.handleRecordLine(line));
  }

  private handleRecordLine(line: string): void {
    if (!line.trim()) return;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      console.error(`[pi-rpc] bad json: ${line}`);
      return;
    }

    if (record.type === 'response' && typeof record.id === 'string' && this.pending.has(record.id)) {
      const response = record as unknown as RpcResponse;
      const pending = this.pending.get(record.id);
      if (!pending) return;
      this.pending.delete(record.id);
      response.success ? pending.resolve(response.data) : pending.reject(new Error(response.error || `${response.command} failed`));
    }

    if (record.type === 'message_update') {
      const event = record.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      if (event?.type === 'text_delta' && event.delta) this.lastAssistantText += event.delta;
    }

    if (record.type === 'agent_settled') {
      this.running = false;
      const waiters = this.waiters.splice(0);
      for (const waiter of waiters) waiter.resolve();
    }
  }

  async command<T = unknown>(type: string, fields: Record<string, unknown> = {}): Promise<T> {
    if (this.config.mock) return this.mockCommand(type, fields) as T;
    this.start();
    if (!this.proc) throw new Error('pi rpc process did not start');
    const id = `cmd-${this.nextId++}`;
    const record = { id, type, ...fields };
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject });
    });
    this.proc.stdin.write(JSON.stringify(record) + '\n');
    return promise;
  }

  async promptAndWait(message: string): Promise<string> {
    if (this.config.mock) {
      return `mock pi reply: ${message.slice(0, 120)}`;
    }
    this.lastAssistantText = '';
    this.running = true;
    let response: PromptResponse;
    try {
      response = await this.command<PromptResponse>('prompt', { message });
    } catch (error) {
      this.running = false;
      throw error;
    }
    if (response?.disposition === 'handled') {
      this.running = false;
      return this.getLastAssistantText();
    }
    await this.waitForSettled();
    const last = await this.command<LastAssistantTextResponse>('get_last_assistant_text').catch(() => ({ text: this.lastAssistantText }));
    return last.text ?? this.lastAssistantText;
  }

  waitForSettled(timeoutMs = 10 * 60 * 1000): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for agent_settled')), timeoutMs);
      this.waiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject,
      });
    });
  }

  getState(): Promise<unknown> {
    return this.command('get_state');
  }

  getMessages(): Promise<unknown> {
    return this.command('get_messages');
  }

  async getLastAssistantText(): Promise<string> {
    const response = await this.command<LastAssistantTextResponse>('get_last_assistant_text');
    return response.text ?? '';
  }

  private async mockCommand(type: string, fields: Record<string, unknown>): Promise<unknown> {
    if (type === 'get_state') return { sessionId: this.config.sessionId, isStreaming: false, mock: true };
    if (type === 'get_messages') return { messages: [] };
    if (type === 'get_last_assistant_text') return { text: this.lastAssistantText };
    if (type === 'prompt') {
      this.lastAssistantText = `mock pi reply: ${String(fields.message).slice(0, 120)}`;
      return { disposition: 'started' };
    }
    return {};
  }

  close(): void {
    if (!this.proc) return;
    if (this.proc.stdin.writable) this.proc.stdin.end();
    this.proc.kill('SIGTERM');
  }
}
