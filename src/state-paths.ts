import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from './types.js';

export function defaultStateDir(): string {
  return path.join(os.homedir(), '.cache', 'pi-personal-daemon');
}

export function stateDir(config: AppConfig): string {
  // Preserve the legacy registry/binding/callback root. contextFile selects only
  // the legacy context import source; callers needing isolation set stateDir.
  return config.runtime.stateDir || defaultStateDir();
}

export function stateDbPath(config: AppConfig): string {
  return path.join(stateDir(config), 'state.sqlite');
}

export function defaultContextFile(): string {
  return path.join(os.tmpdir(), 'pi-personal-daemon-current-context.json');
}

export function contextFile(config: AppConfig): string {
  return config.runtime.contextFile || defaultContextFile();
}

export function legacyContextPath(config: AppConfig): string | undefined {
  // An explicit state directory must not import an unrelated global context.
  return config.runtime.contextFile || (config.runtime.stateDir ? undefined : defaultContextFile());
}
