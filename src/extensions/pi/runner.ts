import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import readline from 'node:readline';
import { agentProcessEnv } from '../../core/runtime/process-paths.js';
import { agentProcessDetached, signalAgentProcess, waitForAgentProcessExit } from '../../core/runtime/process-control.js';
import type { AgentConfig, AppConfig } from '../../types.js';

interface RpcResponse<T = unknown> {
  id?: string;
  type: 'response';
  command: string;
  success: boolean;
  data?: T;
  error?: string;
}

export interface PromptResponse {
  disposition: 'started' | 'queued' | 'handled';
}

interface LastAssistantTextResponse {
  text: string | null;
}

interface PendingCommand {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface PiRpcRunnerOptions {
  commandTimeoutMs?: number;
  settledTimeoutMs?: number;
  spawn?: (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
  signalProcess?: (child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) => boolean;
  confirmExit?: (child: ChildProcessWithoutNullStreams) => boolean | Promise<boolean>;
}

export interface PiContextUsage {
  text: string;
  source: string;
}

interface UsageCandidate {
  used: number;
  limit: number;
  source: string;
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RpcProcess {
  child: ChildProcessWithoutNullStreams;
  reader: readline.Interface;
  pending: Map<string, PendingCommand>;
  waiters: Set<Waiter>;
  lastAssistantText: string;
  running: boolean;
  error: Error | null;
  terminationSignaled: boolean;
  verifyingExit: boolean;
}

export class PiRpcRunner {
  private config: AgentConfig;
  private proc: RpcProcess | null = null;
  private nextId = 1;
  private lastAssistantText = '';
  private lastProcessError: Error | null = null;
  private commandTimeoutMs: number;
  private settledTimeoutMs: number;
  private spawnProcess: NonNullable<PiRpcRunnerOptions['spawn']>;
  private signalProcess: NonNullable<PiRpcRunnerOptions['signalProcess']>;
  private confirmExit: NonNullable<PiRpcRunnerOptions['confirmExit']>;

  constructor(private appConfig: AppConfig, options: PiRpcRunnerOptions = {}) {
    this.config = appConfig.agent;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
    this.settledTimeoutMs = options.settledTimeoutMs ?? 10 * 60 * 1000;
    this.spawnProcess = options.spawn ?? spawn;
    this.signalProcess = options.signalProcess ?? signalAgentProcess;
    this.confirmExit = options.confirmExit ?? waitForAgentProcessExit;
  }

  start(): void {
    if (this.config.mock) return;
    if (this.proc?.error) throw new Error('pi rpc process is stopping');
    if (this.proc) return;
    const args = [
      '--mode', 'rpc',
      '--session-id', this.config.sessionId,
      ...(this.config.sessionDir ? ['--session-dir', this.config.sessionDir] : []),
      ...(this.config.extraArgs || []),
    ];
    const child = this.spawnProcess(this.config.piBin, args, {
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: agentProcessDetached,
      env: agentProcessEnv(this.appConfig),
    });
    const reader = readline.createInterface({ input: child.stdout });
    const proc: RpcProcess = {
      child, reader, pending: new Map(), waiters: new Set(), lastAssistantText: '', running: false, error: null,
      terminationSignaled: false, verifyingExit: false,
    };
    this.proc = proc;
    this.lastProcessError = null;
    child.stderr.on('data', chunk => {
      if (this.proc === proc && !proc.error) process.stderr.write(`[pi] ${chunk}`);
    });
    child.on('error', error => this.finishProcess(proc, error));
    child.on('exit', (code, signal) => this.finishProcess(proc, new Error(`pi rpc exited code=${code} signal=${signal}`)));
    child.on('close', (code, signal) => this.finishProcess(proc, new Error(`pi rpc closed code=${code} signal=${signal}`), true));
    child.stdin.on('error', error => this.finishProcess(proc, error));
    child.stdin.on('close', () => this.finishProcess(proc, new Error('pi rpc stdin closed')));
    child.stdout.on('error', error => this.finishProcess(proc, error));
    child.stderr.on('error', error => this.finishProcess(proc, error));
    reader.on('line', line => this.handleRecordLine(proc, line));
    reader.on('error', error => this.finishProcess(proc, error));
  }

  private finishProcess(proc: RpcProcess, error: Error, closed = false): void {
    if (!proc.error) {
      proc.error = error;
      if (this.proc === proc) this.lastProcessError = error;
      proc.running = false;
      proc.reader.close();
      for (const pending of proc.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      proc.pending.clear();
      for (const waiter of proc.waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      proc.waiters.clear();
      // A leader exit can leave descendants executing, even without RPC pipes.
      // Signal the owned group; close and verified group exit gate replacement.
      try {
        proc.terminationSignaled = proc.child.pid == null || this.signalProcess(proc.child, 'SIGKILL');
      } catch (killError) {
        console.error(`[pi-rpc] failed to terminate: ${killError instanceof Error ? killError.message : String(killError)}`);
      }
    }
    if ((closed || proc.child.pid == null) && proc.terminationSignaled && !proc.verifyingExit && this.proc === proc) {
      proc.verifyingExit = true;
      const release = (exited: boolean) => {
        if (exited && this.proc === proc) this.proc = null;
      };
      try {
        const exited = proc.child.pid == null || this.confirmExit(proc.child);
        if (typeof exited === 'boolean') release(exited);
        else exited.then(release).catch(error => console.error(`[pi-rpc] failed to confirm exit: ${error instanceof Error ? error.message : String(error)}`));
      } catch (error) {
        console.error(`[pi-rpc] failed to confirm exit: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private assertProcess(proc: RpcProcess): void {
    if (proc.error) throw proc.error;
    if (this.proc !== proc) throw new Error('pi rpc process changed');
  }

  private handleRecordLine(proc: RpcProcess, line: string): void {
    if (this.proc !== proc || proc.error || !line.trim()) return;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      console.error(`[pi-rpc] bad json: ${line}`);
      return;
    }

    if (record.type === 'response' && typeof record.id === 'string' && proc.pending.has(record.id)) {
      const response = record as unknown as RpcResponse;
      const pending = proc.pending.get(record.id);
      if (!pending) return;
      proc.pending.delete(record.id);
      clearTimeout(pending.timer);
      response.success ? pending.resolve(response.data) : pending.reject(new Error(response.error || `${response.command} failed`));
    }

    if (record.type === 'message_update') {
      const event = record.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      if (event?.type === 'text_delta' && event.delta) proc.lastAssistantText += event.delta;
    }

    if (record.type === 'agent_settled') this.settleProcess(proc);
  }

  private settleProcess(proc: RpcProcess): void {
    proc.running = false;
    for (const waiter of proc.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    proc.waiters.clear();
  }

  async command<T = unknown>(type: string, fields: Record<string, unknown> = {}): Promise<T> {
    if (this.config.mock) return this.mockCommand(type, fields) as T;
    this.start();
    if (!this.proc) throw new Error('pi rpc process did not start');
    return this.commandForProcess<T>(this.proc, type, fields);
  }

  private commandForProcess<T>(proc: RpcProcess, type: string, fields: Record<string, unknown> = {}): Promise<T> {
    this.assertProcess(proc);
    const id = `cmd-${this.nextId++}`;
    const record = JSON.stringify({ ...fields, id, type }) + '\n';
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.finishProcess(proc, new Error(`timed out waiting for pi rpc ${type} response`));
      }, this.commandTimeoutMs);
      proc.pending.set(id, { resolve: resolve as (data: unknown) => void, reject, timer });
      try {
        if (!proc.child.stdin.writable || proc.child.stdin.destroyed) throw new Error('pi rpc stdin is not writable');
        proc.child.stdin.write(record, error => {
          if (error) this.finishProcess(proc, error);
        });
      } catch (error) {
        this.finishProcess(proc, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  isRunning(): boolean {
    return this.proc?.running ?? false;
  }

  async promptAndWait(message: string): Promise<string> {
    if (this.config.mock) {
      return `mock pi reply: ${message.slice(0, 120)}`;
    }
    this.start();
    const proc = this.proc;
    if (!proc) throw new Error('pi rpc process did not start');
    if (proc.running) throw new Error('pi rpc agent is already running');
    proc.lastAssistantText = '';
    proc.running = true;
    let response: PromptResponse;
    try {
      response = await this.commandForProcess<PromptResponse>(proc, 'prompt', { message });
      this.assertProcess(proc);
    } catch (error) {
      this.finishProcess(proc, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    if (response?.disposition === 'handled') {
      this.settleProcess(proc);
      const last = await this.commandForProcess<LastAssistantTextResponse>(proc, 'get_last_assistant_text');
      return last.text ?? '';
    }
    await this.waitForProcessSettled(proc, this.settledTimeoutMs);
    this.assertProcess(proc);
    const last = await this.commandForProcess<LastAssistantTextResponse>(proc, 'get_last_assistant_text').catch(() => ({ text: proc.lastAssistantText }));
    return last.text ?? proc.lastAssistantText;
  }

  waitForSettled(timeoutMs = this.settledTimeoutMs): Promise<void> {
    const proc = this.proc;
    if (!proc) return this.lastProcessError ? Promise.reject(this.lastProcessError) : Promise.resolve();
    return this.waitForProcessSettled(proc, timeoutMs);
  }

  private waitForProcessSettled(proc: RpcProcess, timeoutMs: number): Promise<void> {
    if (proc.error) return Promise.reject(proc.error);
    if (!proc.running) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.finishProcess(proc, new Error('timed out waiting for agent_settled'));
      }, timeoutMs);
      proc.waiters.add({ resolve, reject, timer });
    });
  }

  steer(message: string): Promise<PromptResponse> {
    if (this.config.mock) return Promise.resolve({ disposition: 'queued' });
    return this.command<PromptResponse>('steer', { message });
  }

  getState(): Promise<unknown> {
    return this.command('get_state');
  }

  async getContextUsage(): Promise<PiContextUsage> {
    const state = await this.getState();
    const messages = await this.getMessages().catch(() => undefined);
    return extractContextUsage(state, messages, this.config.sessionId);
  }

  getMessages(): Promise<unknown> {
    return this.command('get_messages');
  }

  async getLastAssistantText(): Promise<string> {
    const response = await this.command<LastAssistantTextResponse>('get_last_assistant_text');
    return response.text ?? '';
  }

  private async mockCommand(type: string, fields: Record<string, unknown>): Promise<unknown> {
    if (type === 'get_state') {
      return {
        sessionId: this.config.sessionId,
        model: { id: 'mock-model', contextWindow: 1000000, maxTokens: 16384, input: ['text', 'image'] },
        isStreaming: false,
        isCompacting: false,
        messageCount: 2,
        pendingMessageCount: 0,
        mock: true,
      };
    }
    if (type === 'get_messages') return { messages: [] };
    if (type === 'get_last_assistant_text') return { text: this.lastAssistantText };
    if (type === 'prompt') {
      this.lastAssistantText = `mock pi reply: ${String(fields.message).slice(0, 120)}`;
      return { disposition: 'started' };
    }
    if (type === 'steer') return { disposition: 'queued' };
    return {};
  }

  close(): void {
    if (this.proc) this.finishProcess(this.proc, new Error('pi rpc runner closed'));
  }
}

export function extractContextUsage(state: unknown, messages: unknown, _sessionId: string): PiContextUsage {
  const stateUsage = findContextUsagePair(state);
  if (stateUsage) return formatUsage(stateUsage);

  const messageUsage = findLatestMessageUsage(messages, findContextLimit(state));
  if (messageUsage) return formatUsage(messageUsage);

  return { text: 'Context usage unavailable', source: 'pi-rpc context usage unavailable' };
}

function formatUsage(candidate: UsageCandidate): PiContextUsage {
  return { text: `Context ${formatOccupancyPercent(candidate.used, candidate.limit)}`, source: candidate.source };
}

function findContextUsagePair(value: unknown, path = ''): UsageCandidate | null {
  if (!isRecord(value)) return null;
  const used = semanticNumberFrom(value, CONTEXT_USED_KEYS);
  const limit = semanticNumberFrom(value, CONTEXT_LIMIT_KEYS);
  const semanticContainer = /context|token|usage/i.test(`${path} ${Object.keys(value).join(' ')}`);
  if (semanticContainer && used !== undefined && limit !== undefined && validPair(used, limit)) {
    return { used, limit, source: 'pi-rpc get_state context/token usage fields' };
  }
  const percent = semanticNumberFrom(value, CONTEXT_PERCENT_KEYS);
  if (semanticContainer && percent !== undefined) {
    const normalized = percent <= 1 ? percent * 100 : percent;
    if (Number.isFinite(normalized) && normalized >= 0) {
      return { used: normalized, limit: 100, source: 'pi-rpc get_state context usage percent' };
    }
  }
  for (const [key, child] of Object.entries(value)) {
    const found = findContextUsagePair(child, path ? `${path}.${key}` : key);
    if (found) return found;
  }
  return null;
}

function findLatestMessageUsage(messagesPayload: unknown, contextLimit: number | undefined): UsageCandidate | null {
  if (!contextLimit || contextLimit <= 0) return null;
  const messages = isRecord(messagesPayload) && Array.isArray(messagesPayload.messages) ? messagesPayload.messages : [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isRecord(message) || !isRecord(message.usage)) continue;
    const used = usedTokensFromMessageUsage(message.usage);
    if (used !== undefined && validPair(used, contextLimit)) {
      return { used, limit: contextLimit, source: 'pi-rpc get_messages latest assistant usage and model contextWindow' };
    }
  }
  return null;
}

function usedTokensFromMessageUsage(usage: Record<string, unknown>): number | undefined {
  const contextTokens = semanticNumberFrom(usage, /^(contextTokens|context_tokens)$/i);
  if (contextTokens !== undefined) return contextTokens;

  const promptTokens = semanticNumberFrom(usage, /^(promptTokens|inputTokens|prompt_tokens|input_tokens)$/i);
  if (promptTokens !== undefined) return promptTokens;

  const promptParts = [
    semanticNumberFrom(usage, /^input$/i),
    semanticNumberFrom(usage, /^cacheRead$/i),
    semanticNumberFrom(usage, /^cacheWrite$/i),
  ].filter((value): value is number => value !== undefined);
  if (promptParts.length > 0) return promptParts.reduce((sum, value) => sum + value, 0);

  return undefined;
}

function findContextLimit(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const own = semanticNumberFrom(value, CONTEXT_LIMIT_KEYS);
  if (own !== undefined && own > 0) return own;
  for (const child of Object.values(value)) {
    const found = findContextLimit(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

function semanticNumberFrom(object: Record<string, unknown>, keyPattern: RegExp): number | undefined {
  for (const [key, value] of Object.entries(object)) {
    if (!keyPattern.test(key)) continue;
    const number = numericScalar(value);
    if (number !== undefined) return number;
  }
  return undefined;
}

function numericScalar(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) return Number(value);
  return undefined;
}

function validPair(used: number, limit: number): boolean {
  return Number.isFinite(used) && Number.isFinite(limit) && used >= 0 && limit > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function formatOccupancyPercent(used: number, limit: number): string {
  const percent = (used / limit) * 100;
  if (percent > 0 && percent < 1) return '<1%';
  return `${Math.round(percent)}%`;
}

const CONTEXT_USED_KEYS = /^(usedTokens|usedContextTokens|contextUsedTokens|contextTokens|currentTokens|currentContextTokens|promptTokens|inputTokens|used_tokens|used_context_tokens|context_used_tokens|context_tokens|current_tokens|prompt_tokens|input_tokens|tokensUsed|tokens_used)$/i;
const CONTEXT_LIMIT_KEYS = /^(contextWindow|contextLimit|maxContextTokens|maxContextWindow|tokenLimit|context_window|context_limit|max_context_tokens|max_context_window|token_limit|windowTokens|window_tokens|limitTokens|limit_tokens)$/i;
const CONTEXT_PERCENT_KEYS = /^(contextPercent|contextPercentage|contextUsagePercent|contextUsagePercentage|contextRatio|context_percent|context_percentage|context_usage_percent|context_usage_percentage|context_ratio)$/i;
