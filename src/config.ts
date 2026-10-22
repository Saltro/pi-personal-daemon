import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './types.js';

const DEFAULT_CONFIG: AppConfig = {
  agent: {
    sessionId: 'personal-agent',
    cwd: process.cwd(),
    piBin: 'pi',
    extraArgs: [],
    mock: false,
  },
  channel: { type: 'feishu' },
  http: {
    enabled: true,
    host: '127.0.0.1',
    port: 8787,
    path: '/feishu/webhook',
  },
  stdin: {
    enabled: true,
  },
  sender: {
    type: 'mock',
    mockOutbox: path.join(process.cwd(), 'outbox.jsonl'),
  },
  feishu: {
    appId: '',
    appSecret: '',
    verificationToken: '',
    encryptKey: '',
    baseUrl: 'https://open.feishu.cn',
    eventMode: 'ws',
  },
  scheduler: {
    enabled: false,
    wakeups: [],
  },
  runtime: {},
};

function mergeConfig<T>(base: T, override: Partial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override || {})) {
    const baseValue = (base as Record<string, unknown>)[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = mergeConfig(baseValue || {}, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

function boolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function loadConfig(): AppConfig {
  const configPath = path.resolve(process.env.RETRIEVER_CONFIG || path.join(process.cwd(), 'config.json'));
  let fileConfig: Partial<AppConfig> = {};
  if (fs.existsSync(configPath)) {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<AppConfig>;
  }

  const envConfig = {
    agent: {
      sessionId: process.env.RETRIEVER_AGENT_SESSION_ID,
      cwd: process.env.RETRIEVER_AGENT_CWD,
      piBin: process.env.PI_BIN,
      sessionDir: process.env.RETRIEVER_AGENT_SESSION_DIR,
      extraArgs: process.env.RETRIEVER_AGENT_EXTRA_ARGS ? process.env.RETRIEVER_AGENT_EXTRA_ARGS.split(' ').filter(Boolean) : undefined,
      mock: process.env.RETRIEVER_AGENT_MOCK ? boolEnv(process.env.RETRIEVER_AGENT_MOCK, false) : undefined,
      profile: process.env.RETRIEVER_AGENT_PROFILE,
    },
    channel: { type: process.env.RETRIEVER_CHANNEL },
    http: {
      enabled: process.env.RETRIEVER_HTTP_ENABLED ? boolEnv(process.env.RETRIEVER_HTTP_ENABLED, true) : undefined,
      host: process.env.RETRIEVER_HTTP_HOST,
      port: process.env.RETRIEVER_HTTP_PORT ? Number(process.env.RETRIEVER_HTTP_PORT) : undefined,
      path: process.env.RETRIEVER_HTTP_PATH,
    },
    stdin: {
      enabled: process.env.RETRIEVER_STDIN_ENABLED ? boolEnv(process.env.RETRIEVER_STDIN_ENABLED, true) : undefined,
    },
    sender: {
      type: process.env.RETRIEVER_SENDER,
      mockOutbox: process.env.RETRIEVER_MOCK_OUTBOX,
    },
    feishu: {
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
      encryptKey: process.env.FEISHU_ENCRYPT_KEY,
      baseUrl: process.env.FEISHU_BASE_URL,
      eventMode: process.env.FEISHU_EVENT_MODE as 'ws' | 'webhook' | 'both' | undefined,
    },
    scheduler: {
      enabled: process.env.RETRIEVER_SCHEDULER_ENABLED ? boolEnv(process.env.RETRIEVER_SCHEDULER_ENABLED, false) : undefined,
    },
    runtime: {
      contextFile: process.env.RETRIEVER_CONTEXT_FILE,
      stateDir: process.env.RETRIEVER_STATE_DIR,
    },
  };

  const config = mergeConfig(mergeConfig(DEFAULT_CONFIG, fileConfig), stripUndefined(envConfig) as Partial<AppConfig>);
  const baseDir = path.dirname(configPath);
  config.runtime.configPath = configPath;
  config.agent.cwd = path.resolve(baseDir, config.agent.cwd);
  if (config.agent.sessionDir) config.agent.sessionDir = path.resolve(baseDir, config.agent.sessionDir);
  if (config.agent.piBin.includes(path.sep)) config.agent.piBin = path.resolve(baseDir, config.agent.piBin);
  if (config.runtime.stateDir) config.runtime.stateDir = path.resolve(baseDir, config.runtime.stateDir);
  if (config.runtime.contextFile) config.runtime.contextFile = path.resolve(baseDir, config.runtime.contextFile);
  config.sender.mockOutbox = path.resolve(baseDir, config.sender.mockOutbox);
  for (const profile of Object.values(config.agentProfiles || {})) {
    if (profile.cwd) profile.cwd = path.resolve(baseDir, profile.cwd);
    if (profile.sessionDir) profile.sessionDir = path.resolve(baseDir, profile.sessionDir);
    if (profile.backend === 'pi' && profile.piBin?.includes(path.sep)) profile.piBin = path.resolve(baseDir, profile.piBin);
    if (profile.backend === 'process' && profile.command?.includes(path.sep)) profile.command = path.resolve(baseDir, profile.command);
  }
  return config;
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    const stripped = stripUndefined(child);
    if (stripped === undefined) continue;
    out[key] = stripped;
  }
  return out;
}
