import { loadConfig } from '../config.js';
import { createChannelAdapter } from '../core/channels/registry.js';
import { readFeishuChatBinding as readOutputBinding } from '../core/state/binding.js';
import { readCurrentContext, recordContextSend } from '../core/state/context.js';

export function sendUsage(command = 'retriever send'): never {
  console.error(`Usage: ${command} <text...> | --stdin`);
  process.exit(2);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export async function runSendCli(args: string[], command = 'retriever send'): Promise<void> {
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
  const channel = createChannelAdapter(config);
  const binding = readOutputBinding(config);
  if (!binding && channel.type !== 'stdio')
    throw new Error(
      'Output destination is not bound. Run: retriever bind destination --chat-id <chat_id>',
    );
  const chatId = binding?.chatId || 'stdio';
  const context = tryReadCurrentContext(config);
  await channel.sender.send({
    chatId,
    inReplyTo: context?.eventId || 'manual',
    text,
    contextFooter: context?.contextUsage,
  });
  if (context) {
    try {
      const updated = recordContextSend(config, context.eventId);
      console.error(
        `[${command}] sent event=${updated.eventId} chat=${chatId} count=${updated.sendCount}`,
      );
    } catch (error) {
      console.error(
        `[${command}] sent event=${context.eventId} chat=${chatId}; context accounting warning: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    console.error(`[${command}] sent event=manual chat=${chatId}`);
  }
}

function tryReadCurrentContext(config: ReturnType<typeof loadConfig>) {
  try {
    return readCurrentContext(config);
  } catch (error) {
    if (error instanceof Error && error.message.includes('current message context not found'))
      return undefined;
    throw error;
  }
}
