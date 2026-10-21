import { registerAgentAdapter } from '../core/agents/registry.js';
import { mockAdapter } from './mock/adapter.js';
import { piAdapter } from './pi/adapter.js';
import { processAdapter } from './process/adapter.js';

registerAgentAdapter('pi', piAdapter);
registerAgentAdapter('mock', mockAdapter);
registerAgentAdapter('process', processAdapter);
