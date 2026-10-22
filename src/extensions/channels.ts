import { registerChannelAdapter } from '../core/channels/registry.js';
import { FeishuChannel } from './feishu/channel.js';
import { StdinChannel } from './stdin/channel.js';

registerChannelAdapter('feishu', (config) => new FeishuChannel(config));
registerChannelAdapter('stdin', (config) => new StdinChannel(config));
