import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from './types.js';
import type { PersonalSessionRecord } from './session-registry.js';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));

/** Resolve a built sibling from the installed entry point, including npm's bin symlink. */
export function helperBinDirectory(): string {
  if (process.argv[1]) {
    try {
      const entryDirectory = path.dirname(fs.realpathSync(process.argv[1]));
      if (fs.existsSync(path.join(entryDirectory, 'session-watcher.js'))) return entryDirectory;
    } catch { /* Programmatic callers use the module-relative fallback. */ }
  }
  return path.basename(sourceDirectory) === 'dist' ? sourceDirectory : path.resolve(sourceDirectory, '../dist');
}

export function sessionWatcherCommand(): { args: string[] } {
  const built = path.join(helperBinDirectory(), 'session-watcher.js');
  if (fs.existsSync(built)) return { args: [built] };
  // Source-only development uses the already installed tsx loader; production uses the built sibling.
  const source = path.join(sourceDirectory, 'session-watcher.ts');
  const loader = path.resolve(sourceDirectory, '../node_modules/tsx/dist/loader.mjs');
  if (fs.existsSync(source) && fs.existsSync(loader)) return { args: ['--import', loader, source] };
  throw new Error(`session watcher not found: ${built}; build the package before running sessions`);
}

export function absoluteConfigPath(config: AppConfig): string {
  return path.resolve(config.runtime.configPath || process.env.PERSONAL_DAEMON_CONFIG || 'config.json');
}

export function agentProcessEnv(config: AppConfig, record?: PersonalSessionRecord, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extra,
    PERSONAL_DAEMON_CONFIG: absoluteConfigPath(config),
    PATH: `${helperBinDirectory()}${path.delimiter}${extra.PATH ?? process.env.PATH ?? ''}`,
    PI_PERSONAL_SESSION_ID: record?.id || config.agent.sessionId,
    PI_SESSION_ID: record?.sessionId || config.agent.sessionId,
  };
  // Do not leak an enclosing child session's callback into an unrelated execution.
  delete env.PI_PERSONAL_PARENT_CALLBACK;
  if (record?.parentCallback) env.PI_PERSONAL_PARENT_CALLBACK = JSON.stringify(record.parentCallback);
  return env;
}
