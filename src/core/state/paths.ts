import path from 'node:path';
import { xdgDir } from '../../config.js';
import type { AppConfig } from '../../types.js';

export function defaultStateDir(): string {
  return path.join(xdgDir('XDG_STATE_HOME', ['.local', 'state']), 'retriever');
}

export function stateDir(config: AppConfig): string {
  return config.stateDir || defaultStateDir();
}

export function stateDbPath(config: AppConfig): string {
  return path.join(stateDir(config), 'state.sqlite');
}
