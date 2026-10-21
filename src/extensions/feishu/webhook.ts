import crypto from 'node:crypto';
import http, { type IncomingMessage, type Server } from 'node:http';
import { normalizeFeishuInbound } from './normalize.js';
import type { AppConfig, InboundEvent } from '../../types.js';

interface FeishuCallbackPayload {
  type?: string;
  token?: string;
  challenge?: string;
  schema?: string;
  header?: { token?: string };
  encrypt?: string;
}

export function startHttpReceiver(config: AppConfig, onEvent: (event: InboundEvent) => Promise<void>): Server | null {
  if (!config.http.enabled) return null;
  const server = http.createServer(async (req, res) => {
    const requestPath = new URL(req.url || '/', `http://${req.headers.host}`).pathname;
    if (req.method !== 'POST' || requestPath !== config.http.path) {
      res.writeHead(404).end('not found');
      return;
    }

    try {
      const body = await readBody(req);
      const payload = parseFeishuPayload(body, config);
      if (!isValidFeishuToken(payload, config.feishu.verificationToken)) {
        res.writeHead(401).end('bad token');
        return;
      }
      if (payload.type === 'url_verification' && payload.challenge) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ challenge: payload.challenge }));
        return;
      }
      const event = normalizeFeishuInbound(payload, 'http-feishu');
      onEvent(event).catch(error => console.error(`[http-receiver] ${error.stack || error}`));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
    } catch (error) {
      res.writeHead(400).end(error instanceof Error ? error.message : String(error));
    }
  });
  server.listen(config.http.port, config.http.host, () => {
    console.error(`[http-receiver] listening http://${config.http.host}:${config.http.port}${config.http.path}`);
  });
  return server;
}

export function parseFeishuPayload(body: string, config: AppConfig): FeishuCallbackPayload {
  const payload = (body ? JSON.parse(body) : {}) as FeishuCallbackPayload;
  if (!payload.encrypt) return payload;
  if (!config.feishu.encryptKey) throw new Error('encrypted Feishu callback received but FEISHU_ENCRYPT_KEY is not configured');
  return decryptFeishuPayload(payload.encrypt, config.feishu.encryptKey) as FeishuCallbackPayload;
}

export function isValidFeishuToken(payload: FeishuCallbackPayload, expectedToken: string): boolean {
  if (!expectedToken) return true;
  const token = payload.token || payload.header?.token;
  return token === expectedToken;
}

export function decryptFeishuPayload(encrypted: string, encryptKey: string): unknown {
  const encryptedBuffer = Buffer.from(encrypted, 'base64');
  if (encryptedBuffer.length <= 16) throw new Error('invalid encrypted Feishu callback');
  const key = crypto.createHash('sha256').update(encryptKey).digest();
  const iv = encryptedBuffer.subarray(0, 16);
  const cipherText = encryptedBuffer.subarray(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8');
  return JSON.parse(decrypted);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
