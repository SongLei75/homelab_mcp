import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

import type { AppConfig, OAuthJwtConfig } from '../config.js';
import type { AuthContext } from './types.js';

export type OAuthJwtVerifier = ReturnType<typeof createOAuthJwtVerifier>;

export function getBearerToken(headerValue: string | undefined): string | undefined {
  if (!headerValue) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return match?.[1];
}

function getScopes(payload: JWTPayload): string[] {
  const scope = typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : [];
  const permissions = Array.isArray(payload.permissions)
    ? payload.permissions.filter((item): item is string => typeof item === 'string')
    : [];
  return Array.from(new Set([...scope, ...permissions]));
}

export function hasRequiredScopes(scopes: string[], requiredScopes: string[]): boolean {
  return requiredScopes.every(scope => scopes.includes(scope));
}

function authContext(payload: JWTPayload): AuthContext {
  return {
    subject: payload.sub ?? 'unknown',
    issuer: payload.iss ?? '',
    audience: payload.aud ?? '',
    scopes: getScopes(payload),
    claims: payload
  };
}

export function bearerChallenge(config: AppConfig): string {
  const oauth = config.oauthJwt;
  const parts = ['realm="private-mcp"'];
  if (oauth?.metadataUrl) parts.push(`resource_metadata="${oauth.metadataUrl}"`);
  if (oauth?.requiredScopes.length) parts.push(`scope="${oauth.requiredScopes.join(' ')}"`);
  return `Bearer ${parts.join(', ')}`;
}

export function createOAuthJwtVerifier(config: OAuthJwtConfig) {
  const jwks = createRemoteJWKSet(new URL(config.jwksUrl));

  return async function verifyOAuthJwt(token: string): Promise<AuthContext> {
    const verified = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      audience: config.audience
    });
    return authContext(verified.payload);
  };
}
