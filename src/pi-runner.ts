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
    return {};
  }

  close(): void {
    if (!this.proc) return;
    if (this.proc.stdin.writable) this.proc.stdin.end();
    this.proc.kill('SIGTERM');
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
