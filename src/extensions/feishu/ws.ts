import * as Lark from '@larksuiteoapi/node-sdk';
import type { AppConfig, InboundEvent } from '../../types.js';
import { normalizeFeishuInbound } from './normalize.js';

interface StoppableWsClient {
  close(params?: { force?: boolean }): void;
  getConnectionStatus?: () => unknown;
}

export async function startFeishuWsReceiver(
  config: AppConfig,
  onEvent: (event: InboundEvent) => Promise<void>,
): Promise<StoppableWsClient | null> {
  if (config.feishu.eventMode === 'webhook') return null;
  if (!config.feishu.appId || !config.feishu.appSecret) {
    console.error('[feishu-ws] disabled: FEISHU_APP_ID / FEISHU_APP_SECRET not configured');
    return null;
  }

  const dispatcher = new Lark.EventDispatcher({
    encryptKey: config.feishu.encryptKey || undefined,
    verificationToken: config.feishu.verificationToken || undefined,
  }).register({
    'im.message.receive_v1': (data: unknown) => {
      const event = normalizeFeishuInbound(data, 'feishu-ws');
      setImmediate(() => {
        onEvent(event).catch((error) => console.error(`[feishu-ws] ${error.stack || error}`));
      });
    },
  });

  const wsClient = new Lark.WSClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    loggerLevel: Lark.LoggerLevel.info,
    onReady: () => console.error('[feishu-ws] ready'),
    onError: (error) =>
      console.error(
        `[feishu-ws] ${error instanceof Error ? error.stack || error.message : String(error)}`,
      ),
    onReconnecting: () => console.error('[feishu-ws] reconnecting'),
    onReconnected: () => console.error('[feishu-ws] reconnected'),
  });

  await wsClient.start({ eventDispatcher: dispatcher });
  console.error('[feishu-ws] connected');
  return wsClient;
}
