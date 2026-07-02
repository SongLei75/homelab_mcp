import type { MiddlewareHandler } from 'hono';
import type { JWTPayload } from 'jose';

export type AuthMiddleware = MiddlewareHandler;

export interface AuthContext {
  subject: string;
  issuer: string;
  audience: string | string[];
  scopes: string[];
  claims: JWTPayload;
}

export function hasScope(auth: AuthContext | undefined, scope: string): boolean {
  if (!auth) return true;
  return auth.scopes.includes(scope);
}
