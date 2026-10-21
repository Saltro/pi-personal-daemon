import { registerChannelAdapter } from '../core/channels/registry.js';
import { FeishuChannel } from './feishu/channel.js';
import { StdioChannel } from './stdio/channel.js';

registerChannelAdapter('feishu', config => new FeishuChannel(config));
registerChannelAdapter('stdio', config => new StdioChannel(config));
