import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../src/config.js';
import { signStandardWebhook } from '../src/events/security.js';
import { createApp } from '../src/http/app.js';

const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'collab-test', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {}
};

function mcpHeaders(method: string, name?: string): Record<string, string> {
  return {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'Mcp-Protocol-Version': '2026-07-28',
    'Mcp-Method': method,
    ...(name ? { 'Mcp-Name': name } : {})
  };
}

async function rpc(
  app: Awaited<ReturnType<typeof createApp>>['app'],
  id: number,
  method: string,
  params: Record<string, unknown> = {}
) {
  const response = await app.request('/mcp', {
    method: 'POST',
    headers: mcpHeaders(method, typeof params.name === 'string' ? params.name : typeof params.uri === 'string' ? params.uri : undefined),
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { _meta: meta, ...params } })
  });
  return { status: response.status, headers: response.headers, body: (await response.json()) as any };
}

function makeConfig(dir: string): AppConfig {
  return {
    host: '127.0.0.1',
    port: 8787,
    authMode: 'off',
    allowedOrigins: [],
    auditToStdout: false,
    timeoutMs: 3000,
    maxOutputBytes: 4096,
    auditLogFile: join(dir, 'audit.jsonl'),
    auditMaxBytes: 1024 * 1024,
    collab: {
      dbPath: join(dir, 'events.db'),
      dispatcherIntervalMs: 60_000
    }
  };
}

describe('Collab Message & Events Center MVP (Tests A-D)', () => {
  it('Test A: persists messages across service restarts and deduplicates idempotency_key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-collab-a-'));
    const cfg = makeConfig(dir);

    const instance1 = await createApp(cfg);
    const pub1 = await rpc(instance1.app, 1, 'tools/call', {
      name: 'message_publish',
      arguments: {
        channel: 'general',
        content: 'Hello from Client A',
        idempotency_key: 'idem-001'
      }
    });
    expect(pub1.status).toBe(200);
    const msgId = pub1.body.result.structuredContent.message_id;
    expect(msgId).toMatch(/^msg_/);

    const pubDup = await rpc(instance1.app, 2, 'tools/call', {
      name: 'message_publish',
      arguments: {
        channel: 'general',
        content: 'Hello from Client A',
        idempotency_key: 'idem-001'
      }
    });
    expect(pubDup.body.result.structuredContent.message_id).toBe(msgId);
    instance1.close();

    // Restart service with the same SQLite database
    const instance2 = await createApp(cfg);
    try {
      const readRes = await rpc(instance2.app, 3, 'tools/call', {
        name: 'message_read',
        arguments: { channel: 'general', after_id: 0, limit: 10 }
      });
      expect(readRes.status).toBe(200);
      expect(readRes.body.result.structuredContent.messages).toHaveLength(1);
      expect(readRes.body.result.structuredContent.messages[0].content).toBe('Hello from Client A');
    } finally {
      instance2.close();
    }
  });

  it('Test B: emits notifications/resources/updated across HTTP requests via subscriptions/listen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-collab-b-'));
    const { app, close } = await createApp(makeConfig(dir));

    try {
      const abortController = new AbortController();
      const listenRes = await app.request('/mcp', {
        method: 'POST',
        headers: mcpHeaders('subscriptions/listen'),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 10,
          method: 'subscriptions/listen',
          params: {
            _meta: meta,
            notifications: { resourceSubscriptions: ['collab://channels/general/messages'] }
          }
        }),
        signal: abortController.signal
      });

      expect(listenRes.status).toBe(200);
      expect(listenRes.headers.get('content-type')).toContain('text/event-stream');

      const reader = listenRes.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      async function readUntil(substring: string): Promise<string> {
        while (!buffer.includes(substring)) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
        }
        return buffer;
      }

      await readUntil('notifications/subscriptions/acknowledged');

      const pubRes = await rpc(app, 11, 'tools/call', {
        name: 'message_publish',
        arguments: {
          channel: 'general',
          content: 'Cross-request SSE notification test'
        }
      });
      expect(pubRes.status).toBe(200);

      const streamOutput = await readUntil('notifications/resources/updated');
      expect(streamOutput).toContain('collab://channels/general/messages');
      abortController.abort();

      const resourceRead = await rpc(app, 12, 'resources/read', {
        uri: 'collab://channels/general/messages'
      });
      expect(resourceRead.status).toBe(200);
      const snapshot = JSON.parse(resourceRead.body.result.contents[0].text);
      expect(snapshot.messages[0].content).toBe('Cross-request SSE notification test');
    } finally {
      close();
    }
  });

  it('Test C & D: supports events/list, events/subscribe challenge, Standard Webhooks signature, unsubscribe, and restart retry', async () => {
    process.env.PRIVATE_MCP_TEST_ALLOW_LOOPBACK = '1';
    const dir = await mkdtemp(join(tmpdir(), 'mcp-collab-cd-'));
    const cfg = makeConfig(dir);

    const received: Array<{ headers: http.IncomingHttpHeaders; rawBody: string; parsed: any }> = [];
    let shouldFail = false;

    const webhookServer = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const parsed = JSON.parse(rawBody);

      if (parsed.type === 'verification') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ challenge: parsed.challenge }));
        return;
      }

      if (shouldFail) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('Simulated temporary outage');
        return;
      }

      received.push({ headers: req.headers, rawBody, parsed });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>(resolve => webhookServer.listen(0, '127.0.0.1', resolve));
    const address = webhookServer.address() as { port: number };
    const callbackUrl = `http://127.0.0.1:${address.port}/webhook`;
    const secret = 'whsec_dGVzdF9zZWNyZXRfa2V5X2F0X2xlYXN0XzE2X2J5dGVz';

    try {
      const instance1 = await createApp(cfg);

      const listRes = await rpc(instance1.app, 1, 'events/list');
      expect(listRes.status).toBe(200);
      expect(listRes.body.result.events[0].name).toBe('message.created');
      expect(listRes.body.result.events[0].delivery).toEqual(['webhook']);

      const subRes = await rpc(instance1.app, 2, 'events/subscribe', {
        name: 'message.created',
        arguments: { channel: 'general' },
        delivery: { mode: 'webhook', url: callbackUrl, secret }
      });
      expect(subRes.status).toBe(200);
      expect(subRes.body.result.id).toMatch(/^sub_/);
      expect(subRes.body.result.cursor).toBeNull();
      expect(subRes.body.result.truncated).toBe(false);
      expect(subRes.body.result.refreshBefore).toMatch(/^20/);

      const pub1 = await rpc(instance1.app, 3, 'tools/call', {
        name: 'message_publish',
        arguments: { channel: 'general', content: 'Webhook live test' }
      });
      await instance1.dispatcher.tick();

      expect(received).toHaveLength(1);
      const firstDelivery = received[0];
      const expectedSig = signStandardWebhook(
        String(firstDelivery.headers['webhook-id']),
        Number(firstDelivery.headers['webhook-timestamp']),
        firstDelivery.rawBody,
        secret
      );
      expect(firstDelivery.headers['webhook-signature']).toBe(expectedSig);
      expect(firstDelivery.headers['x-mcp-subscription-id']).toBe(subRes.body.result.id);
      expect(firstDelivery.parsed.data.message_id).toBe(pub1.body.result.structuredContent.message_id);
      expect(firstDelivery.parsed.name).toBe('message.created');
      expect(firstDelivery.parsed.eventId).toMatch(/^evt_/);
      expect(firstDelivery.parsed.cursor).toBeNull();

      // Test D: simulate temporary failure, close (service stop), then recover after restart
      shouldFail = true;
      const pubFail = await rpc(instance1.app, 4, 'tools/call', {
        name: 'message_publish',
        arguments: { channel: 'general', content: 'Message during webhook outage' }
      });
      await instance1.dispatcher.tick();
      expect(received).toHaveLength(1);
      instance1.close();

      // Service restarts and webhook endpoint recovers
      shouldFail = false;
      const instance2 = await createApp({
        ...cfg,
        collab: { ...cfg.collab, webhookMaxAttempts: 5 }
      });
      // Fast-forward next_attempt_at in SQLite via a retry tick after backoff window or direct SQLite update
      (instance2.subscriptionStore as any).db.exec("UPDATE deliveries SET next_attempt_at = 0 WHERE status = 'pending'");
      await instance2.dispatcher.tick();

      expect(received).toHaveLength(2);
      expect(received[1].parsed.data.message_id).toBe(pubFail.body.result.structuredContent.message_id);

      // Unsubscribe and verify no more deliveries
      const unsubRes = await rpc(instance2.app, 5, 'events/unsubscribe', {
        name: 'message.created',
        arguments: { channel: 'general' },
        delivery: { url: callbackUrl }
      });
      expect(unsubRes.body.result).toMatchObject({ resultType: 'complete' });

      await rpc(instance2.app, 6, 'tools/call', {
        name: 'message_publish',
        arguments: { channel: 'general', content: 'After unsubscribe' }
      });
      await instance2.dispatcher.tick();
      expect(received).toHaveLength(2);

      instance2.close();
    } finally {
      delete process.env.PRIVATE_MCP_TEST_ALLOW_LOOPBACK;
      webhookServer.close();
    }
  });
});
