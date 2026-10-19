#!/usr/bin/env node
import { loadConfig } from './config.js';
import { PersonalDaemon } from './daemon.js';

const config = loadConfig();
const daemon = new PersonalDaemon(config);

daemon.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.error(`[daemon] ${signal}; shutting down`);
    daemon.stop();
    process.exit(0);
  });
}
