import type { AgentAdapter } from '../../core/agents/types.js';
import { agentProcessEnv } from '../../core/runtime/process-paths.js';
import { PiRpcRunner } from './runner.js';

export const piAdapter: AgentAdapter = {
  sessionCapabilities: { prompt: true, steer: false, history: false, contextUsage: false },
  createMainRunner(config, profile) {
    if (profile.backend !== 'pi') throw new Error('invalid Pi agent profile');
    const runner = new PiRpcRunner(config, {
      cwd: profile.cwd,
      sessionDir: profile.sessionDir,
      bin: profile.bin || config.extensions.pi.bin,
      extraArgs: profile.extraArgs || [],
      commandTimeoutMs: profile.timeoutMs,
    });
    return Object.assign(runner, {
      capabilities: { prompt: true, steer: true, history: true, contextUsage: true },
    });
  },
  sessionProcess(config, profile, record, prompt) {
    if (profile.backend !== 'pi') throw new Error('invalid Pi agent profile');
    return {
      command: profile.bin || config.extensions.pi.bin,
      args: [
        '--print',
        '--session-id',
        record.sessionId,
        ...(record.sessionDir ? ['--session-dir', record.sessionDir] : []),
        '--approve',
        prompt,
        ...(profile.extraArgs || []),
      ],
      env: agentProcessEnv(config, record),
    };
  },
};
