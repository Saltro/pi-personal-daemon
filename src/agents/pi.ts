import { PiRpcRunner } from '../pi-runner.js';
import { agentProcessEnv } from '../process-paths.js';
import type { AgentAdapter } from './types.js';

export const piAdapter: AgentAdapter = {
  sessionCapabilities: { prompt: true, steer: false, history: false, contextUsage: false },
  createMainRunner(config, profile) {
    if (profile.backend !== 'pi') throw new Error('invalid Pi agent profile');
    const runner = new PiRpcRunner({
      ...config,
      agent: {
        ...config.agent,
        cwd: profile.cwd || config.agent.cwd,
        sessionDir: profile.sessionDir,
        piBin: profile.piBin || 'pi',
        extraArgs: profile.extraArgs || [],
        commandTimeoutMs: profile.commandTimeoutMs,
        mock: false,
      },
    }, { commandTimeoutMs: profile.commandTimeoutMs });
    return Object.assign(runner, { capabilities: { prompt: true, steer: true, history: true, contextUsage: true } });
  },
  sessionProcess(config, profile, record, prompt) {
    if (profile.backend !== 'pi') throw new Error('invalid Pi agent profile');
    return {
      command: profile.piBin || 'pi',
      args: [
        '--print', '--session-id', record.sessionId,
        ...(record.sessionDir ? ['--session-dir', record.sessionDir] : []),
        '--approve', prompt,
        ...(profile.extraArgs || []),
      ],
      env: agentProcessEnv(config, record),
    };
  },
};
