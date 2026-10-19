import { loadConfig } from './config.js';
import { readFeishuChatBinding } from './feishu-binding.js';
import { createSender } from './sender.js';
import { readCurrentContext, recordContextSend } from './runtime-context.js';

export function sendUsage(command = 'pi-personal send'): never {
  console.error(`Usage: ${command} <text...> | --stdin`);
  process.exit(2);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export async function runSendCli(args: string[], command = 'pi-personal send'): Promise<void> {
  let text: string;
  if (args.length === 1 && args[0] === '--stdin') {
    text = await readStdin();
  } else if (args.length > 0) {
    text = args.join(' ');
  } else {
    sendUsage(command);
  }

  text = text.trim();
  if (!text) sendUsage(command);

  const config = loadConfig();
  const binding = readFeishuChatBinding(config);
  if (!binding) throw new Error('Feishu chat is not bound. Run: pi-personal bind feishu-chat --chat-id <chat_id>');
  const context = tryReadCurrentContext(config);
  await createSender(config).send({
    chatId: binding.chatId,
    inReplyTo: context?.eventId || 'manual',
    text,
  });
  if (context) {
    const updated = recordContextSend(config);
    console.error(`[${command}] sent event=${updated.eventId} chat=${binding.chatId} count=${updated.sendCount}`);
  } else {
    console.error(`[${command}] sent event=manual chat=${binding.chatId}`);
  }
}

function tryReadCurrentContext(config: ReturnType<typeof loadConfig>) {
  try {
    return readCurrentContext(config);
  } catch (error) {
    if (error instanceof Error && error.message.includes('current message context not found')) return undefined;
    throw error;
  }
}
