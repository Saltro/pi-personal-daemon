/** Internal test-only surface: a mock sender captures outbound replies. */
export interface SenderConfig {
  type: string;
  mockOutbox: string;
}

export interface ExtensionsConfig {
  pi: PiExtensionConfig;
  feishu: FeishuExtensionConfig;
}

export interface PiExtensionConfig {
  bin: string;
  extraArgs: string[];
  sessionDir?: string;
  timeoutMs?: number;
}

export interface FeishuExtensionConfig {
  appId: string;
  appSecret: string;
}

interface AgentProfileBase {
  cwd?: string;
  sessionDir?: string;
}

export interface PiAgentProfile extends AgentProfileBase {
  backend: 'pi';
  bin?: string;
  extraArgs?: string[];
  timeoutMs?: number;
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

export interface AppConfig {
  workspaceDir: string;
  agentProfiles?: Record<string, AgentProfile>;
  channel?: { type: string };
  extensions: ExtensionsConfig;
  stateDir?: string;
  /** Internal: resolved config file path used to resolve relative paths. */
  configPath?: string;
  /** Internal: test-only outbound capture. */
  sender?: SenderConfig;
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
