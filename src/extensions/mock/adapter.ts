import type { MockAgentProfile } from '../../types.js';
import { unsupportedCapability, type AgentAdapter, type AgentRunner } from '../../core/agents/types.js';
import { PiRpcRunner } from '../pi/runner.js';

export function mockReply(profile: MockAgentProfile, prompt: string): string {
  return `${profile.replyPrefix ?? 'mock pi reply: '}${prompt.slice(0, 120)}`;
}

class MockAgentRunner implements AgentRunner {
  readonly capabilities = { prompt: true, steer: false, history: false, contextUsage: false };
  constructor(private profile: MockAgentProfile) {}
  start(): void {}
  isRunning(): boolean { return false; }
  promptAndWait(message: string): Promise<string> { return Promise.resolve(mockReply(this.profile, message)); }
  waitForSettled(): Promise<void> { return Promise.resolve(); }
  steer(_message: string): ReturnType<AgentRunner['steer']> { return Promise.reject(unsupportedCapability('mock', 'steer')); }
  getState(): Promise<unknown> { return Promise.resolve({ backend: 'mock', isRunning: false, mock: true }); }
  getMessages(): Promise<unknown> { return Promise.reject(unsupportedCapability('mock', 'native history')); }
  getContextUsage(): ReturnType<AgentRunner['getContextUsage']> {
    return Promise.resolve({ text: 'Context usage unavailable', source: 'mock backend does not support context usage' });
  }
  close(): void {}
}

export const mockAdapter: AgentAdapter = {
  sessionCapabilities: { prompt: true, steer: false, history: false, contextUsage: false },
  createMainRunner(config, profile) {
    if (profile.backend !== 'mock') throw new Error('invalid mock agent profile');
    // Legacy `agent.mock` mode keeps Pi's state/context shape while mocking completions.
    if ((!config.agent.profile || config.agent.profile === 'default') && !config.agentProfiles?.default) {
      return Object.assign(new PiRpcRunner(config), { capabilities: { prompt: true, steer: true, history: false, contextUsage: false } });
    }
    return new MockAgentRunner(profile);
  },
  sessionProcess(_config, profile, _record, prompt) {
    if (profile.backend !== 'mock') throw new Error('invalid mock agent profile');
    return mockReply(profile, prompt);
  },
};
