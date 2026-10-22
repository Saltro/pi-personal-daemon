import type { AgentProfile, AppConfig } from '../../types.js';
import type { PersonalSessionRecord } from '../sessions/registry.js';

export interface AgentCapabilities {
  prompt: boolean;
  steer: boolean;
  history: boolean;
  contextUsage: boolean;
}

export interface AgentRunner {
  readonly capabilities: AgentCapabilities;
  start(): void;
  isRunning(): boolean;
  promptAndWait(message: string): Promise<string>;
  waitForSettled(timeoutMs?: number): Promise<void>;
  steer(message: string): Promise<{ disposition: 'started' | 'queued' | 'handled' }>;
  getState(): Promise<unknown>;
  getMessages(): Promise<unknown>;
  getContextUsage(): Promise<{ text: string; source: string }>;
  close(): void;
}

export interface AgentProcess {
  command: string;
  args: string[];
  stdin?: string;
  timeoutMs?: number;
  env: NodeJS.ProcessEnv;
}

export interface AgentAdapter {
  readonly sessionCapabilities: AgentCapabilities;
  createMainRunner(config: AppConfig, profile: AgentProfile): AgentRunner;
  sessionProcess(
    config: AppConfig,
    profile: AgentProfile,
    record: PersonalSessionRecord,
    prompt: string,
  ): AgentProcess | string;
}

export function unsupportedCapability(backend: string, capability: string): Error {
  return new Error(`agent backend ${backend} does not support ${capability}`);
}
