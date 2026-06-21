import type { MiddlewareHandler } from 'hono';

import type { AppConfig } from '../config.js';
import { AuditLogger } from '../audit/audit.js';

function getBearerToken(headerValue: string | undefined): string | undefined {
  if (!headerValue) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return match?.[1];
}

export function createAuthMiddleware(config: AppConfig, audit: AuditLogger): MiddlewareHandler {
  return async (c, next) => {
    const requestId = c.get('requestId') as string;

    if (config.authMode === 'off') {
      await next();
      return;
    }

    if (config.authMode === 'oauth_placeholder') {
      await audit.write({
        requestId,
        event: 'auth.oauth_placeholder',
        decision: 'deny',
        reason: 'OAuth is intentionally not implemented in P0',
        authMode: config.authMode
      });
      return c.json({ error: 'oauth_placeholder_not_implemented' }, 501);
    }

    const actual = getBearerToken(c.req.header('Authorization'));
    if (!actual || actual !== config.staticBearerToken) {
      await audit.write({
        requestId,
        event: 'auth.static_bearer',
        decision: 'deny',
        reason: 'missing or invalid bearer token',
        authMode: config.authMode
      });
      return c.json({ error: 'unauthorized' }, 401);
    }

    await next();
  };
}
