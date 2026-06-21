import type { MiddlewareHandler } from 'hono';

import type { AppConfig } from '../config.js';
import { AuditLogger } from '../audit/audit.js';

function isAllowedOrigin(origin: string, allowedOrigins: string[]): boolean {
  return allowedOrigins.includes('*') || allowedOrigins.includes(origin);
}

export function createOriginGuard(config: AppConfig, audit: AuditLogger): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') {
      await next();
      return;
    }

    const requestId = c.get('requestId') as string;
    const origin = c.req.header('Origin') ?? null;

    if (!origin) {
      await audit.write({
        requestId,
        event: 'origin.empty',
        decision: 'allow',
        origin
      });
      await next();
      return;
    }

    if (!isAllowedOrigin(origin, config.allowedOrigins)) {
      await audit.write({
        requestId,
        event: 'origin.check',
        decision: 'deny',
        origin,
        reason: 'origin not in allowlist'
      });
      return c.json({ error: 'origin_not_allowed' }, 403);
    }

    await audit.write({
      requestId,
      event: 'origin.check',
      decision: 'allow',
      origin
    });
    await next();
  };
}
