import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from './types.js';

/** The single main session identity; not user-configurable. */
export const MAIN_SESSION_ID = 'personal-agent';

function defaultConfig(): AppConfig {
  return {
    workspaceDir: defaultWorkspaceDir(),
    channel: { type: 'feishu' },
    extensions: {
      pi: { bin: 'pi', extraArgs: [] },
      feishu: { appId: '', appSecret: '' },
    },
  };
}

/** XDG variables must be absolute; ignore relative values as the spec requires. */
export function xdgDir(variable: string, fallback: string[]): string {
  const value = process.env[variable];
  if (value && path.isAbsolute(value)) return value;
  return path.join(os.homedir(), ...fallback);
}

export function defaultConfigPath(): string {
  return path.join(xdgDir('XDG_CONFIG_HOME', ['.config']), 'retriever', 'config.json');
}

export function defaultWorkspaceDir(): string {
  return path.join(xdgDir('XDG_DATA_HOME', ['.local', 'share']), 'retriever');
}

export function resolveConfigPath(): string {
  return path.resolve(process.env.RETRIEVER_CONFIG || defaultConfigPath());
}

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

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function loadConfig(): AppConfig {
  const configPath = resolveConfigPath();
  let fileConfig: Partial<AppConfig> = {};
  if (fs.existsSync(configPath)) {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<AppConfig>;
  }

  const envConfig: DeepPartial<AppConfig> = {
    workspaceDir: process.env.RETRIEVER_WORKSPACE_DIR,
    stateDir: process.env.RETRIEVER_STATE_DIR,
    channel: process.env.RETRIEVER_CHANNEL ? { type: process.env.RETRIEVER_CHANNEL } : undefined,
    extensions: {
      pi: {
        bin: process.env.PI_BIN,
        extraArgs: process.env.RETRIEVER_PI_EXTRA_ARGS
          ? process.env.RETRIEVER_PI_EXTRA_ARGS.split(' ').filter(Boolean)
          : undefined,
        sessionDir: process.env.RETRIEVER_PI_SESSION_DIR,
        timeoutMs: process.env.RETRIEVER_PI_TIMEOUT_MS
          ? Number(process.env.RETRIEVER_PI_TIMEOUT_MS)
          : undefined,
      },
      feishu: {
        appId: process.env.FEISHU_APP_ID,
        appSecret: process.env.FEISHU_APP_SECRET,
      },
    },
  };

  const config = mergeConfig(
    mergeConfig(defaultConfig(), fileConfig),
    stripUndefined(envConfig) as Partial<AppConfig>,
  );
  const baseDir = path.dirname(configPath);
  config.configPath = configPath;
  config.workspaceDir = path.resolve(baseDir, config.workspaceDir);
  fs.mkdirSync(config.workspaceDir, { recursive: true });
  if (config.stateDir) config.stateDir = path.resolve(baseDir, config.stateDir);
  const pi = config.extensions.pi;
  if (pi.sessionDir) pi.sessionDir = path.resolve(baseDir, pi.sessionDir);
  if (pi.bin.includes(path.sep)) pi.bin = path.resolve(baseDir, pi.bin);
  for (const profile of Object.values(config.agentProfiles || {})) {
    if (profile.backend === 'mock') continue;
    if (profile.cwd) profile.cwd = path.resolve(baseDir, profile.cwd);
    if (profile.sessionDir) profile.sessionDir = path.resolve(baseDir, profile.sessionDir);
    if (profile.backend === 'pi' && profile.bin?.includes(path.sep))
      profile.bin = path.resolve(baseDir, profile.bin);
    if (profile.backend === 'process' && profile.command.includes(path.sep))
      profile.command = path.resolve(baseDir, profile.command);
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
