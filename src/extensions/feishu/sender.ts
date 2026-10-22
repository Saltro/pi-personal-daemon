import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, FeishuConfig, OutboundReply, Sender, SenderConfig } from '../../types.js';

interface TenantTokenResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

interface FeishuApiResponse {
  code?: number;
  msg?: string;
  data?: unknown;
}

export class MockSender implements Sender {
  private outbox: string;

  constructor(config: SenderConfig) {
    this.outbox = config.mockOutbox;
    fs.mkdirSync(path.dirname(this.outbox), { recursive: true });
  }

  async send(reply: OutboundReply): Promise<{ ok: true; mock: true }> {
    const card = buildReplyCard(reply);
    const record = {
      ...reply,
      card,
      msgType: 'interactive',
      sentAt: new Date().toISOString(),
      transport: 'mock',
    };
    fs.appendFileSync(this.outbox, `${JSON.stringify(record)}\n`);
    console.error(
      `[mock-send] chat=${reply.chatId} markdown=${JSON.stringify(reply.text)} footer=${JSON.stringify(reply.contextFooter || '')}`,
    );
    return { ok: true, mock: true };
  }

  async addReaction(messageId: string, emojiType: string): Promise<{ ok: true; mock: true }> {
    const record = {
      messageId,
      emojiType,
      sentAt: new Date().toISOString(),
      transport: 'mock-reaction',
    };
    fs.appendFileSync(this.outbox, `${JSON.stringify(record)}\n`);
    console.error(`[mock-reaction] message=${messageId} emoji=${emojiType}`);
    return { ok: true, mock: true };
  }
}

export class FeishuSender implements Sender {
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private config: FeishuConfig) {}

  async send(reply: OutboundReply): Promise<FeishuApiResponse> {
    return this.withTokenRetry(() => this.sendWithToken(reply));
  }

  async addReaction(messageId: string, emojiType: string): Promise<FeishuApiResponse> {
    return this.withTokenRetry(() => this.addReactionWithToken(messageId, emojiType));
  }

  private async sendWithToken(reply: OutboundReply): Promise<FeishuApiResponse> {
    const token = await this.getTenantAccessToken();
    const response = await fetch(
      `${this.baseUrl()}/open-apis/im/v1/messages?receive_id_type=chat_id`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          receive_id: reply.chatId,
          msg_type: 'interactive',
          content: JSON.stringify(buildReplyCard(reply)),
        }),
      },
    );
    const body = (await response.json().catch(() => ({}))) as FeishuApiResponse;
    if (!response.ok || body.code) {
      throw new Error(
        `Feishu send failed http=${response.status} code=${body.code ?? 'unknown'} msg=${body.msg ?? response.statusText}`,
      );
    }
    return body;
  }

  private async addReactionWithToken(
    messageId: string,
    emojiType: string,
  ): Promise<FeishuApiResponse> {
    const token = await this.getTenantAccessToken();
    const response = await fetch(
      `${this.baseUrl()}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          reaction_type: { emoji_type: emojiType },
        }),
      },
    );
    const body = (await response.json().catch(() => ({}))) as FeishuApiResponse;
    if (!response.ok || body.code) {
      throw new Error(
        `Feishu reaction failed http=${response.status} code=${body.code ?? 'unknown'} msg=${body.msg ?? response.statusText}`,
      );
    }
    return body;
  }

  private async withTokenRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (isTokenError(error)) {
        this.token = null;
        this.tokenExpiresAt = 0;
        return fn();
      }
      throw error;
    }
  }

  private async getTenantAccessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    if (!this.config.appId || !this.config.appSecret) {
      throw new Error('Feishu sender requires FEISHU_APP_ID and FEISHU_APP_SECRET.');
    }
    const response = await fetch(
      `${this.baseUrl()}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }),
      },
    );
    const body = (await response.json().catch(() => ({}))) as TenantTokenResponse;
    if (!response.ok || body.code || !body.tenant_access_token) {
      throw new Error(
        `Feishu token failed http=${response.status} code=${body.code ?? 'unknown'} msg=${body.msg ?? response.statusText}`,
      );
    }
    this.token = body.tenant_access_token;
    this.tokenExpiresAt = Date.now() + Math.max(1, body.expire ?? 7200) * 1000;
    return this.token;
  }

  private baseUrl(): string {
    return (this.config.baseUrl || 'https://open.feishu.cn').replace(/\/$/, '');
  }
}

function isTokenError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /token|99991663|99991664|99991665|99991668/i.test(message);
}

function buildReplyCard(reply: OutboundReply): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [{ tag: 'markdown', content: reply.text }];
  if (reply.contextFooter) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: `<font color="grey"><font size="small">${escapeLarkMd(reply.contextFooter)}</font></font>`,
    });
  }
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'fill' },
    body: { direction: 'vertical', elements },
  };
}

function escapeLarkMd(text: string): string {
  return text.replace(
    /[<&>]/g,
    (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[char] || char,
  );
}

export function createSender(config: AppConfig): Sender {
  if (config.sender.type === 'feishu') return new FeishuSender(config.feishu);
  return new MockSender(config.sender);
}
