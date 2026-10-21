import { loadConfig } from './config.js';
import { writeParentReturnNotification } from './session-callbacks.js';
import { getSession, type ParentCallback } from './session-registry.js';

export function returnUsage(command = 'pi-personal return'): never {
  console.error(`Usage: ${command} <text...> | --stdin`);
  process.exit(2);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export async function runReturnCli(args: string[], command = 'pi-personal return'): Promise<void> {
  let text: string;
  if (args.length === 1 && args[0] === '--stdin') {
    text = await readStdin();
  } else if (args.length > 0) {
    text = args.join(' ');
  } else {
    returnUsage(command);
  }

  text = text.trim();
  if (!text) returnUsage(command);

  const config = loadConfig();
  const parent = findParentCallback(config);
  if (!parent) throw new Error('parent callback metadata not found; create or send the child from a parent agent session, or run from a cron target session; --return only controls automatic completion notices');
  const file = writeParentReturnNotification(config, parent, text, process.env.PI_PERSONAL_SESSION_ID || process.env.PI_SESSION_ID);
  console.error(`[${command}] queued parent return ${file}`);
}

function findParentCallback(config: ReturnType<typeof loadConfig>): ParentCallback | undefined {
  const encoded = process.env.PI_PERSONAL_PARENT_CALLBACK;
  if (encoded) return JSON.parse(encoded) as ParentCallback;

  const personalSessionId = process.env.PI_PERSONAL_SESSION_ID;
  if (personalSessionId) {
    try {
      return getSession(config, personalSessionId).parentCallback;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('session not found')) throw error;
    }
  }

  const piSessionId = process.env.PI_SESSION_ID;
  if (piSessionId) {
    try {
      return getSession(config, piSessionId).parentCallback;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('session not found')) throw error;
    }
  }

  return undefined;
}
