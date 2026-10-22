import readline, { type Interface } from 'node:readline';
import type { AppConfig, InboundEvent } from '../../types.js';
import { normalizeInbound } from '../events.js';

/** Line-delimited JSON or plain text on stdin, independent of the selected channel. */
export function startStdinReceiver(
  config: AppConfig,
  onEvent: (event: InboundEvent) => Promise<void>,
): Interface | null {
  if (!config.stdin.enabled) return null;
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const payload = trimmed.startsWith('{')
        ? JSON.parse(trimmed)
        : { type: 'message', text: trimmed, chatId: 'stdin' };
      onEvent(normalizeInbound(payload, 'stdin')).catch((error) =>
        console.error(`[stdin-receiver] ${error.stack || error}`),
      );
    } catch (error) {
      console.error(
        `[stdin-receiver] bad input: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  console.error('[stdin-receiver] ready; type text or JSON lines');
  return rl;
}
