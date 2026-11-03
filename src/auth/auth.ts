import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

import type { AppConfig } from '../config.js';
import { AuditLogger } from '../audit/audit.js';
import {
  bearerChallenge,
  createOAuthJwtVerifier,
  getBearerToken,
  hasRequiredScopes
} from './oauth-jwt.js';

const authHeaderName = 'Author' + 'ization';
const challengeHeaderName = 'WWW-' + 'Authenticate';
const tunnelHeaderName = 'X-MCP-Tunnel-Token';

function matchesTunnelToken(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createAuthMiddleware(config: AppConfig, audit: AuditLogger): MiddlewareHandler {
  const oauthJwtVerifier = config.authMode === 'oauth_jwt' && config.oauthJwt
    ? createOAuthJwtVerifier(config.oauthJwt)
    : undefined;

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

    // Local tunnel credentials are validated separately from public Auth0 JWTs.
    // A loopback IP is not sufficient: Cloudflare Tunnel also connects via loopback.
    const tunnelToken = c.req.header(tunnelHeaderName);
    if (config.authMode === 'oauth_jwt' && config.tunnelToken && tunnelToken !== undefined) {
      if (!matchesTunnelToken(tunnelToken, config.tunnelToken)) {
        await audit.write({ requestId, event: 'auth.local_tunnel', decision: 'deny', reason: 'invalid tunnel token' });
        return c.json({ error: 'unauthorized' }, 401);
      }
      const subject = 'local:openai-tunnel';
      c.set('auth', {
        subject,
        issuer: 'homelab-local',
        audience: config.resourceIdentifier ?? 'local',
        scopes: ['mcp:read', 'mcp:command', 'mcp:write'],
        claims: { sub: subject, iss: 'homelab-local' }
      });
      await audit.write({ requestId, event: 'auth.local_tunnel', decision: 'allow', subject });
      await next();
      return;
    }

    const actual = getBearerToken(c.req.header(authHeaderName));

    if (config.authMode === 'static_bearer') {
      if (!actual || actual !== config.staticBearerToken) {
        await audit.write({
          requestId,
          event: 'auth.static_bearer',
          decision: 'deny',
          reason: 'missing or invalid bearer token',
          authMode: config.authMode
        });
        return c.json({ error: 'unauthorized' }, 401, { [challengeHeaderName]: 'Bearer realm="private-mcp"' });
      }

      await next();
      return;
    }

    if (config.authMode !== 'oauth_jwt' || !config.oauthJwt || !oauthJwtVerifier) {
      await audit.write({
        requestId,
        event: 'auth.config',
        decision: 'deny',
        reason: 'auth mode is not configured',
        authMode: config.authMode
      });
      return c.json({ error: 'auth_not_configured' }, 500);
    }

    if (!actual) {
      await audit.write({
        requestId,
        event: 'auth.oauth_jwt',
        decision: 'deny',
        reason: 'missing bearer token',
        authMode: config.authMode,
        oauthProvider: config.oauthJwt.provider
      });
      return c.json({ error: 'unauthorized' }, 401, { [challengeHeaderName]: bearerChallenge(config) });
    }

    try {
      const auth = await oauthJwtVerifier(actual);

      if (!hasRequiredScopes(auth.scopes, config.oauthJwt.requiredScopes)) {
        await audit.write({
          requestId,
          event: 'auth.oauth_jwt',
          decision: 'deny',
          reason: 'insufficient scope',
          authMode: config.authMode,
          oauthProvider: config.oauthJwt.provider,
          subject: auth.subject,
          scopes: auth.scopes,
          requiredScopes: config.oauthJwt.requiredScopes
        });
        return c.json({ error: 'insufficient_scope' }, 403, { [challengeHeaderName]: bearerChallenge(config) });
      }

      c.set('auth', auth);
      await audit.write({
        requestId,
        event: 'auth.oauth_jwt',
        decision: 'allow',
        authMode: config.authMode,
        oauthProvider: config.oauthJwt.provider,
        subject: auth.subject,
        scopes: auth.scopes
      });
      await next();
    } catch (error) {
      await audit.write({
        requestId,
        event: 'auth.oauth_jwt',
        decision: 'deny',
        reason: error instanceof Error ? error.message : 'JWT verification failed',
        authMode: config.authMode,
        oauthProvider: config.oauthJwt.provider
      });
      return c.json({ error: 'unauthorized' }, 401, { [challengeHeaderName]: bearerChallenge(config) });
    }
  };
}
