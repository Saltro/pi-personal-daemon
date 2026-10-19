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
  const configPath = process.env.PERSONAL_DAEMON_CONFIG || path.join(process.cwd(), 'config.json');
  let fileConfig: Partial<AppConfig> = {};
  if (fs.existsSync(configPath)) {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<AppConfig>;
  }

  const envConfig = {
    agent: {
      sessionId: process.env.PI_DAEMON_SESSION_ID,
      cwd: process.env.PI_DAEMON_CWD,
      piBin: process.env.PI_BIN,
      sessionDir: process.env.PI_DAEMON_SESSION_DIR,
      extraArgs: process.env.PI_DAEMON_EXTRA_ARGS ? process.env.PI_DAEMON_EXTRA_ARGS.split(' ').filter(Boolean) : undefined,
      mock: process.env.PI_DAEMON_MOCK ? boolEnv(process.env.PI_DAEMON_MOCK, false) : undefined,
    },
    http: {
      enabled: process.env.PI_DAEMON_HTTP_ENABLED ? boolEnv(process.env.PI_DAEMON_HTTP_ENABLED, true) : undefined,
      host: process.env.PI_DAEMON_HTTP_HOST,
      port: process.env.PI_DAEMON_HTTP_PORT ? Number(process.env.PI_DAEMON_HTTP_PORT) : undefined,
      path: process.env.PI_DAEMON_HTTP_PATH,
    },
    stdin: {
      enabled: process.env.PI_DAEMON_STDIN_ENABLED ? boolEnv(process.env.PI_DAEMON_STDIN_ENABLED, true) : undefined,
    },
    sender: {
      type: process.env.PI_DAEMON_SENDER,
      mockOutbox: process.env.PI_DAEMON_MOCK_OUTBOX,
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
      enabled: process.env.PI_DAEMON_SCHEDULER_ENABLED ? boolEnv(process.env.PI_DAEMON_SCHEDULER_ENABLED, false) : undefined,
    },
    runtime: {
      contextFile: process.env.PI_DAEMON_CONTEXT_FILE,
      stateDir: process.env.PI_DAEMON_STATE_DIR,
    },
  };

  return mergeConfig(mergeConfig(DEFAULT_CONFIG, fileConfig), stripUndefined(envConfig) as Partial<AppConfig>);
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
