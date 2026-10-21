export interface AgentConfig {
  sessionId: string;
  cwd: string;
  piBin: string;
  sessionDir?: string;
  extraArgs: string[];
  mock: boolean;
  profile?: string;
  commandTimeoutMs?: number;
}

interface AgentProfileBase {
  cwd?: string;
  sessionDir?: string;
}

export interface PiAgentProfile extends AgentProfileBase {
  backend: 'pi';
  piBin?: string;
  extraArgs?: string[];
  commandTimeoutMs?: number;
}

export interface MockAgentProfile extends AgentProfileBase {
  backend: 'mock';
  replyPrefix?: string;
}

/** A plain-text process, not a Pi RPC/print-compatible executable. */
export interface ProcessAgentProfile extends AgentProfileBase {
  backend: 'process';
  command: string;
  args?: string[];
  promptMode?: 'stdin' | 'argument';
  timeoutMs?: number;
  env?: Record<string, string>;
}

export type AgentProfile = PiAgentProfile | MockAgentProfile | ProcessAgentProfile;

export interface RuntimeConfig {
  contextFile?: string;
  stateDir?: string;
  configPath?: string;
}

export interface HttpConfig {
  enabled: boolean;
  host: string;
  port: number;
  path: string;
}

export interface StdinConfig {
  enabled: boolean;
}

export interface SenderConfig {
  type: 'mock' | 'feishu' | string;
  mockOutbox: string;
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  baseUrl: string;
  eventMode: 'ws' | 'webhook' | 'both';
}

export interface WakeupConfig {
  id?: string;
  intervalMs?: number;
  cron?: string;
  prompt?: string;
  text?: string;
  chatId?: string;
}

export interface SchedulerConfig {
  enabled: boolean;
  wakeups: WakeupConfig[];
}

export interface AppConfig {
  agent: AgentConfig;
  agentProfiles?: Record<string, AgentProfile>;
  channel?: { type: string };
  http: HttpConfig;
  stdin: StdinConfig;
  sender: SenderConfig;
  feishu: FeishuConfig;
  scheduler: SchedulerConfig;
  runtime: RuntimeConfig;
}

export interface InboundEvent {
  id: string;
  source: string;
  kind: 'message' | 'wake';
  chatId: string;
  userId?: string;
  messageId?: string;
  text: string;
  raw?: unknown;
}

export interface OutboundReply {
  chatId: string;
  inReplyTo: string;
  text: string;
  contextFooter?: string;
}

export interface Sender {
  send(reply: OutboundReply): Promise<unknown>;
  addReaction?(messageId: string, emojiType: string): Promise<unknown>;
}

export interface RuntimeContext {
  chatId: string;
  eventId: string;
  messageId?: string;
  source: string;
  kind: InboundEvent['kind'];
  textChars: number;
  startedAt: string;
  sendCount: number;
  lastSentAt?: string;
  contextUsage?: string;
  contextUsageSource?: string;
}
