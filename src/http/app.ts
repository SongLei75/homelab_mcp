import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { cors } from 'hono/cors';

import type { AppConfig } from '../config.js';
import { AuditLogger } from '../audit/audit.js';
import { createAuthMiddleware } from '../auth/auth.js';
import { createOriginGuard } from './origin.js';
import { createMcpServer } from '../mcp/server.js';
import { createMcpTransport } from '../mcp/transport.js';

type HonoEnv = {
  Variables: {
    requestId: string;
  };
};

export async function createApp(config: AppConfig) {
  const audit = new AuditLogger(config);
  const server = createMcpServer(audit);
  const transport = createMcpTransport();

  await server.connect(transport);

  const app = new Hono<HonoEnv>();

  app.use('*', async (c, next) => {
    c.set('requestId', randomUUID());
    await next();
  });

  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: [
        'Content-Type',
        'Authorization',
        'mcp-session-id',
        'Last-Event-ID',
        'mcp-protocol-version'
      ],
      exposeHeaders: ['mcp-session-id', 'mcp-protocol-version']
    })
  );

  app.get('/healthz', c =>
    c.json({
      status: 'ok',
      name: 'mcp-local-gateway',
      version: '0.1.0',
      authMode: config.authMode,
      endpoint: '/mcp'
    })
  );

  app.use('/mcp', createOriginGuard(config, audit));
  app.use('/mcp', createAuthMiddleware(config, audit));

  app.all('/mcp', c => transport.handleRequest(c.req.raw));

  return { app, audit };
}
