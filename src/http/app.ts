import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { McpServer } from '@modelcontextprotocol/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

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

type McpHttpSession = {
  id?: string;
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  createdAt: number;
  lastSeenAt: number;
};

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;

function jsonRpcHttpError(status: number, code: number, message: string): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      error: { code, message },
      id: null
    },
    { status, headers: { 'Content-Type': 'application/json' } }
  );
}

async function isInitializeRequest(req: Request): Promise<boolean> {
  if (req.method !== 'POST') return false;

  try {
    const body = await req.clone().json();
    const messages = Array.isArray(body) ? body : [body];
    return messages.some(message => message?.method === 'initialize');
  } catch {
    return false;
  }
}

export async function createApp(config: AppConfig) {
  const audit = new AuditLogger(config);
  const sessions = new Map<string, McpHttpSession>();
  const sessionTtlMs = config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;

  async function closeSession(session: McpHttpSession): Promise<void> {
    if (session.id) sessions.delete(session.id);
    await session.transport.close().catch(() => undefined);
  }

  async function createSession(): Promise<McpHttpSession> {
    const now = Date.now();
    const session = {} as McpHttpSession;
    const transport = createMcpTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: sessionId => {
        session.id = sessionId;
        session.lastSeenAt = Date.now();
        sessions.set(sessionId, session);
      },
      onsessionclosed: sessionId => {
        if (sessionId) sessions.delete(sessionId);
      }
    });
    const server = createMcpServer(audit, config);

    Object.assign(session, {
      server,
      transport,
      createdAt: now,
      lastSeenAt: now
    });

    await server.connect(transport);
    return session;
  }

  function getSession(sessionId: string | null): McpHttpSession | undefined {
    if (!sessionId) return undefined;
    const session = sessions.get(sessionId);
    if (session) session.lastSeenAt = Date.now();
    return session;
  }

  function cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (now - session.lastSeenAt > sessionTtlMs) {
        void closeSession(session);
      }
    }
  }

  const cleanupTimer = setInterval(cleanupExpiredSessions, Math.min(sessionTtlMs, 60_000));
  cleanupTimer.unref?.();

  const app = new Hono<HonoEnv>();

  app.use('*', async (c, next) => {
    c.set('requestId', randomUUID());
    await next();
  });

  app.use(
    '*',
    cors({
      origin: origin => {
        if (!origin) return null;
        if (config.allowedOrigins.includes('*')) return origin;
        return config.allowedOrigins.includes(origin) ? origin : null;
      },
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
      endpoint: '/mcp',
      sessions: sessions.size,
      sessionTtlMs
    })
  );

  app.use('/mcp', createOriginGuard(config, audit));
  app.use('/mcp', createAuthMiddleware(config, audit));

  app.all('/mcp', async c => {
    cleanupExpiredSessions();

    const req = c.req.raw;
    const sessionId = req.headers.get('mcp-session-id');
    const existing = getSession(sessionId);

    if (existing) {
      return existing.transport.handleRequest(req);
    }

    if (sessionId) {
      return jsonRpcHttpError(404, -32001, 'Session not found');
    }

    if (!(await isInitializeRequest(req))) {
      return jsonRpcHttpError(400, -32000, 'Bad Request: Mcp-Session-Id header is required');
    }

    const session = await createSession();
    const response = await session.transport.handleRequest(req);

    if (!session.id) {
      await closeSession(session);
    }

    return response;
  });

  return { app, audit };
}
