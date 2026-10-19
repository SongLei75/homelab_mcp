import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createMcpHandler } from '@modelcontextprotocol/server';

import type { AppConfig } from '../config.js';
import { AuditLogger } from '../audit/audit.js';
import { createAuthMiddleware } from '../auth/auth.js';
import type { AuthContext } from '../auth/types.js';
import { createOriginGuard } from './origin.js';
import { createMcpServer } from '../mcp/server.js';
import {
  hashDebugValue,
  runWithMcpRequestContext,
  summarizeJsonRpcRequest,
  type McpRequestContext
} from '../observability/request-context.js';

type HonoEnv = {
  Variables: {
    requestId: string;
    auth?: AuthContext;
  };
};

const challengeHeaderName = 'WWW-' + 'Authenticate';
const requestAuthHeaderName = 'Author' + 'ization';

function protectedResourceMetadata(config: AppConfig) {
  return {
    resource: config.resourceIdentifier ?? config.oauthJwt?.audience,
    authorization_servers: config.oauthJwt ? [config.oauthJwt.issuer] : [],
    scopes_supported: ['mcp:read', 'mcp:command', 'mcp:write', 'offline_access'],
    bearer_methods_supported: ['header'],
    resource_documentation: config.publicBaseUrl ? `${config.publicBaseUrl}/mcp` : undefined
  };
}

export async function createApp(config: AppConfig) {
  const audit = new AuditLogger(config);
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
        requestAuthHeaderName,
        'Mcp-Protocol-Version',
        'Mcp-Method',
        'Mcp-Name'
      ],
      exposeHeaders: ['Mcp-Protocol-Version', challengeHeaderName]
    })
  );

  app.get('/healthz', c =>
    c.json({
      status: 'ok',
      name: 'mcp-local-gateway',
      version: '0.1.0',
      authMode: config.authMode,
      endpoint: '/mcp',
      resource: config.resourceIdentifier,
      protocolVersion: '2026-07-28'
    })
  );

  app.get('/.well-known/oauth-protected-resource', c => c.json(protectedResourceMetadata(config)));
  app.get('/.well-known/oauth-protected-resource/mcp', c => c.json(protectedResourceMetadata(config)));

  app.use('/mcp', createOriginGuard(config, audit));
  app.use('/mcp', createAuthMiddleware(config, audit));

  app.all('/mcp', async c => {
    const startedAt = Date.now();
    const req = c.req.raw;
    const summary = await summarizeJsonRpcRequest(req);
    const context: McpRequestContext = {
      requestId: c.get('requestId'),
      openaiSessionHash: hashDebugValue(req.headers.get('x-openai-session')),
      openaiSubjectHash: hashDebugValue(req.headers.get('x-openai-subject')),
      rpcIds: summary.rpcIds,
      rpcMethods: summary.rpcMethods,
      bodyHash: summary.bodyHash,
      bodyBytes: summary.bodyBytes,
      cfRay: req.headers.get('cf-ray') ?? undefined,
      traceparent: req.headers.get('traceparent') ?? undefined,
      userAgent: req.headers.get('user-agent') ?? undefined
    };

    const correlationFields = () => ({
      openaiSessionHash: context.openaiSessionHash,
      openaiSubjectHash: context.openaiSubjectHash,
      rpcIds: context.rpcIds,
      rpcMethods: context.rpcMethods,
      bodyHash: context.bodyHash,
      bodyBytes: context.bodyBytes,
      cfRay: context.cfRay,
      traceparent: context.traceparent,
      userAgent: context.userAgent
    });

    await audit.write({
      requestId: context.requestId,
      event: 'mcp.http.request',
      decision: 'info',
      httpMethod: req.method,
      ...correlationFields()
    });

    async function finish(response: Response): Promise<Response> {
      await audit.write({
        requestId: context.requestId,
        event: 'mcp.http.response',
        decision: response.status < 400 ? 'allow' : 'error',
        httpMethod: req.method,
        httpStatus: response.status,
        durationMs: Date.now() - startedAt,
        ...correlationFields()
      });
      return response;
    }

    // New MCP protocol requests are isolated by the upstream stateless handler.
    // Build the server per request so Auth0 scope-filtered tools never leak across users.
    const handler = createMcpHandler(
      () => createMcpServer(audit, config, c.get('auth')),
      { legacy: 'reject' }
    );
    const response = await runWithMcpRequestContext(context, () => handler.fetch(req));
    return finish(response);
  });

  return { app, audit };
}
