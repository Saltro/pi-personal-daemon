#!/usr/bin/env node
import './extensions/agents.js';
import path from 'node:path';
import { loadConfig } from './config.js';
import { executeSessionRun } from './core/sessions/service.js';
import type { AppConfig } from './types.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function send(message: { type: string; error?: string }): void {
  if (process.connected) process.send?.(message, error => {
    if (error) console.error(`[session-watcher] launcher notification failed: ${error.message}`);
  });
}

async function launchConfig(): Promise<AppConfig> {
  if (!process.send) return loadConfig();
  return new Promise<AppConfig>((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('session watcher did not receive launch confirmation')), 10_000);
    const done = (error?: Error, config?: AppConfig) => {
      clearTimeout(timer);
      process.removeListener('message', onMessage);
      process.removeListener('disconnect', onDisconnect);
      error ? reject(error) : resolve(config!);
    };
    const onDisconnect = () => done(new Error('session launcher disconnected before confirmation'));
    const onMessage = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const message = value as { type?: string; config?: AppConfig };
      if (message.type !== 'launch') return;
      if (!message.config?.agent || !message.config.runtime) done(new Error('session watcher launch config missing'));
      else done(undefined, message.config);
    };
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
    send({ type: 'ready' });
  });
}

async function main(): Promise<void> {
  const configPath = arg('--config');
  if (configPath) process.env.RETRIEVER_CONFIG = path.resolve(configPath);
  const id = arg('--id');
  const runId = arg('--run-id');
  const promptFile = arg('--prompt-file');
  if (!id || !runId || !promptFile) throw new Error('Usage: session-watcher --config <path> --id <id> --run-id <token> --prompt-file <path>');
  const config = await launchConfig();
  await executeSessionRun(config, id, runId, promptFile, () => send({ type: 'launched' }));
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[session-watcher] ${message}`);
  send({ type: 'failed', error: message });
  process.exitCode = 1;
}).finally(() => {
  if (process.connected) process.disconnect?.();
});
