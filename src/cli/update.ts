import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { selfPackageRoot } from '../core/runtime/process-paths.js';

interface SelfPackage {
  name: string;
  version: string;
}

export function readSelfPackage(): SelfPackage {
  const root = selfPackageRoot();
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { name?: string; version?: string };
  if (!raw.name || !raw.version) throw new Error(`invalid package.json at ${root}`);
  return { name: raw.name, version: raw.version };
}

export type PackageManager = 'npm' | 'pnpm';

/** Infer the package manager that owns this install from the resolved entry path. */
export function detectPackageManager(entryPath?: string): PackageManager | undefined {
  const resolved = entryPath
    ?? (process.argv[1] ? fs.realpathSync(process.argv[1]) : '');
  const segments = resolved.split(path.sep);
  if (segments.includes('.pnpm')) return 'pnpm';
  if (segments.includes('node_modules')) return 'npm';
  return undefined;
}

/** Parses `npm/pnpm view <spec> version --json`: a JSON string or an array of strings. */
export function parseViewVersions(stdout: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  const versions = (Array.isArray(parsed) ? parsed : [parsed])
    .filter((value): value is string => typeof value === 'string')
    .filter(value => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value));
  return versions.at(-1);
}

function viewVersion(manager: PackageManager, spec: string): string | undefined {
  const result = spawnSync(manager, ['view', spec, 'version', '--json'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${manager} view ${spec} failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  }
  return parseViewVersions(result.stdout);
}

function usage(): never {
  console.error(`Usage:
  retriever update [--latest]`);
  process.exit(2);
}

export async function runUpdateCli(args: string[]): Promise<void> {
  let latest = false;
  for (const arg of args) {
    if (arg === '--latest') latest = true;
    else usage();
  }

  const self = readSelfPackage();
  const manager = detectPackageManager();
  if (!manager) {
    throw new Error(`update needs a global package-manager install; this process runs from ${selfPackageRoot()}`);
  }

  const spec = latest ? `${self.name}@latest` : `${self.name}@^${self.version}`;
  const target = viewVersion(manager, spec);
  if (!target) throw new Error(`could not resolve ${spec}`);

  if (target === self.version) {
    console.log(`${self.name} ${self.version} is already the ${latest ? 'latest' : 'latest compatible'} version`);
    return;
  }

  console.log(`Updating ${self.name} ${self.version} -> ${target} via ${manager}`);
  const installArgs = manager === 'pnpm'
    ? ['add', '-g', `${self.name}@${target}`]
    : ['install', '-g', `${self.name}@${target}`];
  const result = spawnSync(manager, installArgs, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${manager} ${installArgs.join(' ')} exited with ${result.status}`);
  console.log(`Updated ${self.name} to ${target}. Run "retriever daemon restart" to use it.`);
}

export function runVersionCli(): void {
  console.log(readSelfPackage().version);
}
