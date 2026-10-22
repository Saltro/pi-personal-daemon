import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../../types.js';
import type { PersonalSessionRecord } from '../sessions/registry.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = findPackageRoot(moduleDirectory);
const buildDirectory = path.join(packageRoot, 'dist');

function findPackageRoot(start: string): string {
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    if (path.dirname(dir) === dir) return start;
  }
}

/**
 * Locate the package actually being executed. The bundler freezes `import.meta.url` at build
 * time, so derive the root from the real entry path (src/index.ts or dist/index.js).
 */
export function selfPackageRoot(): string {
  if (process.argv[1]) {
    try {
      const entryDirectory = path.dirname(fs.realpathSync(process.argv[1]));
      return findPackageRoot(entryDirectory);
    } catch { /* Programmatic callers keep the build-time root. */ }
  }
  return packageRoot;
}

/** Resolve a built sibling from the installed entry point, including npm's bin symlink. */
export function helperBinDirectory(): string {
  if (process.argv[1]) {
    try {
      const entryDirectory = path.dirname(fs.realpathSync(process.argv[1]));
      if (fs.existsSync(path.join(entryDirectory, 'session-watcher.js'))) return entryDirectory;
    } catch { /* Programmatic callers use the package-relative fallback. */ }
  }
  return buildDirectory;
}

export function sessionWatcherCommand(): { args: string[] } {
  const built = path.join(helperBinDirectory(), 'session-watcher.js');
  if (fs.existsSync(built)) return { args: [built] };
  // Source-only development uses the already installed tsx loader; production uses the built sibling.
  const source = path.join(packageRoot, 'src/session-watcher.ts');
  const loader = path.join(packageRoot, 'node_modules/tsx/dist/loader.mjs');
  if (fs.existsSync(source) && fs.existsSync(loader)) return { args: ['--import', loader, source] };
  throw new Error(`session watcher not found: ${built}; build the package before running sessions`);
}

/** Re-run this entry point, including the tsx loader when running from source. */
export function selfCommand(args: string[]): { command: string; args: string[] } {
  const entry = process.argv[1] ? fs.realpathSync(process.argv[1]) : undefined;
  if (!entry) throw new Error('cannot locate the daemon entry point');
  if (entry.endsWith('.ts')) {
    const loader = path.join(packageRoot, 'node_modules/tsx/dist/loader.mjs');
    if (fs.existsSync(loader)) return { command: process.execPath, args: ['--import', loader, entry, ...args] };
  }
  return { command: process.execPath, args: [...process.execArgv, entry, ...args] };
}

export function absoluteConfigPath(config: AppConfig): string {
  return path.resolve(config.runtime.configPath || process.env.RETRIEVER_CONFIG || 'config.json');
}

export function agentProcessEnv(config: AppConfig, record?: PersonalSessionRecord, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extra,
    RETRIEVER_CONFIG: absoluteConfigPath(config),
    PATH: `${helperBinDirectory()}${path.delimiter}${extra.PATH ?? process.env.PATH ?? ''}`,
    RETRIEVER_SESSION_ID: record?.id || config.agent.sessionId,
    PI_SESSION_ID: record?.sessionId || config.agent.sessionId,
  };
  // Do not leak an enclosing child session's callback into an unrelated execution.
  delete env.RETRIEVER_PARENT_CALLBACK;
  if (record?.parentCallback) env.RETRIEVER_PARENT_CALLBACK = JSON.stringify(record.parentCallback);
  return env;
}
