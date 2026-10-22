import path from 'node:path';
import type { AgentProfile, AppConfig } from '../../types.js';
import { mainSessionRecord } from '../sessions/main.js';
import type { PersonalSessionRecord } from '../sessions/registry.js';
import type { AgentAdapter, AgentRunner } from './types.js';

export type { AgentCapabilities, AgentProcess, AgentRunner } from './types.js';

// Backends are compiled in and registered once from src/extensions/index.ts.
const adapters = new Map<string, AgentAdapter>();

export function registerAgentAdapter(backend: string, adapter: AgentAdapter): void {
  if (adapters.has(backend)) throw new Error(`Agent adapter already registered: ${backend}`);
  adapters.set(backend, adapter);
}

function adapterFor(backend: string): AgentAdapter {
  const adapter = adapters.get(backend);
  if (!adapter) throw new Error(`unsupported agent backend: ${backend}`);
  return adapter;
}

export function resolveAgentProfile(
  config: AppConfig,
  requested?: string,
): { name: string; profile: AgentProfile } {
  const name = requested ?? 'default';
  if (!name.trim()) throw new Error('agent profile name must not be empty');
  let profile = config.agentProfiles?.[name];
  if (!profile) {
    if (name !== 'default') throw new Error(`agent profile not found: ${name}`);
    profile = defaultAgentProfile(config);
  }
  return { name, profile: snapshotAgentProfile(config, profile) };
}

function defaultAgentProfile(config: AppConfig): AgentProfile {
  const pi = config.extensions.pi;
  return {
    backend: 'pi',
    cwd: config.workspaceDir,
    sessionDir: pi.sessionDir,
    bin: pi.bin,
    extraArgs: pi.extraArgs,
    timeoutMs: pi.timeoutMs,
  };
}

export function snapshotAgentProfile(config: AppConfig, profile: AgentProfile): AgentProfile {
  if (!profile || !adapters.has(profile.backend))
    throw new Error(`unsupported agent backend: ${profile?.backend}`);
  const baseDir = config.configPath ? path.dirname(config.configPath) : config.workspaceDir;
  const cwd = path.resolve(baseDir, profile.cwd || config.workspaceDir);
  const sessionDir = profile.sessionDir ? path.resolve(baseDir, profile.sessionDir) : undefined;
  if (profile.backend === 'pi') {
    const bin = profile.bin || config.extensions.pi.bin;
    if (
      profile.extraArgs &&
      (!Array.isArray(profile.extraArgs) ||
        profile.extraArgs.some((value) => typeof value !== 'string'))
    )
      throw new Error('Pi agent extraArgs must be strings');
    if (
      profile.timeoutMs !== undefined &&
      (!Number.isFinite(profile.timeoutMs) ||
        profile.timeoutMs <= 0 ||
        profile.timeoutMs > 2_147_483_647)
    )
      throw new Error('Pi timeoutMs must be between 1 and 2147483647');
    return {
      ...profile,
      cwd,
      sessionDir,
      bin: bin.includes(path.sep) ? path.resolve(baseDir, bin) : bin,
      extraArgs: [...(profile.extraArgs || [])],
    };
  }
  if (profile.backend === 'mock') return { ...profile, cwd, sessionDir };
  if (typeof profile.command !== 'string' || !profile.command.trim())
    throw new Error('process agent command is required');
  if (profile.promptMode && !['stdin', 'argument'].includes(profile.promptMode))
    throw new Error('process agent promptMode must be stdin or argument');
  if (
    profile.timeoutMs !== undefined &&
    (!Number.isFinite(profile.timeoutMs) ||
      profile.timeoutMs <= 0 ||
      profile.timeoutMs > 2_147_483_647)
  )
    throw new Error('process agent timeoutMs must be between 1 and 2147483647');
  if (
    profile.args &&
    (!Array.isArray(profile.args) || profile.args.some((value) => typeof value !== 'string'))
  )
    throw new Error('process agent args must be strings');
  if (profile.env && Object.values(profile.env).some((value) => typeof value !== 'string'))
    throw new Error('process agent env values must be strings');
  return {
    ...profile,
    cwd,
    sessionDir,
    command: profile.command.includes(path.sep)
      ? path.resolve(baseDir, profile.command)
      : profile.command,
    args: [...(profile.args || [])],
    env: { ...(profile.env || {}) },
    promptMode: profile.promptMode || 'stdin',
  };
}

export function sessionAgentProfile(
  config: AppConfig,
  record: PersonalSessionRecord,
): { name: string; profile: AgentProfile } {
  if (record.agentProfileSnapshot)
    return {
      name: record.agentProfile || 'default',
      profile: snapshotAgentProfile(config, record.agentProfileSnapshot),
    };
  if (record.agentProfile) return resolveAgentProfile(config, record.agentProfile);
  // Imported sessions predate named profiles: retain their recorded workspace.
  const profile: AgentProfile = {
    ...defaultAgentProfile(config),
    cwd: record.cwd,
    sessionDir: record.sessionDir,
  };
  return { name: 'legacy', profile: snapshotAgentProfile(config, profile) };
}

export function sessionAgentProcess(
  config: AppConfig,
  record: PersonalSessionRecord,
  prompt: string,
) {
  const { profile } = sessionAgentProfile(config, record);
  return adapterFor(profile.backend).sessionProcess(config, profile, record, prompt);
}

export function mainSessionAgentProfile(
  config: AppConfig,
  record: PersonalSessionRecord,
): { name: string; profile: AgentProfile } {
  return record.agentProfile || record.agentProfileSnapshot
    ? sessionAgentProfile(config, record)
    : resolveAgentProfile(config);
}

export function createMainAgentRunner(config: AppConfig): AgentRunner {
  const record = mainSessionRecord(config);
  const { profile } = mainSessionAgentProfile(config, record);
  return adapterFor(profile.backend).createMainRunner(config, profile, record);
}
