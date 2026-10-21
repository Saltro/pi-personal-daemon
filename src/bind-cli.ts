import { loadConfig } from './config.js';
import { bindingPath, readFeishuChatBinding, writeFeishuChatBinding } from './feishu-binding.js';

function usage(): never {
  console.error(`Usage:
  pi-personal bind destination --chat-id <chat_id>
  pi-personal bind feishu-chat --chat-id <chat_id>
  pi-personal bind status`);
  process.exit(2);
}

function needValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

export async function runBindCli(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  const config = loadConfig();
  if (command === 'feishu-chat' || command === 'destination') {
    let chatId: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--chat-id') chatId = needValue(rest, ++i, arg);
      else usage();
    }
    if (!chatId) usage();
    const binding = writeFeishuChatBinding(config, chatId, 'manual');
    console.log(JSON.stringify({ ...binding, path: bindingPath(config) }, null, 2));
    return;
  }
  if (command === 'status') {
    const binding = readFeishuChatBinding(config);
    console.log(JSON.stringify({ bound: Boolean(binding), binding, path: bindingPath(config) }, null, 2));
    return;
  }
  usage();
}
