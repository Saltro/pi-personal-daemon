import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../../types.js';

export function defaultStateDir(): string {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'retriever');
}

export function stateDir(config: AppConfig): string {
  return config.stateDir || defaultStateDir();
}

export function stateDbPath(config: AppConfig): string {
  return path.join(stateDir(config), 'state.sqlite');
}
