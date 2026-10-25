import { homedir } from 'node:os';
import net from 'node:net';
import { dirname, join } from 'node:path';

export type AuthMode = 'off' | 'static_bearer' | 'oauth_placeholder' | 'oauth_jwt';

export interface OAuthJwtConfig {
  provider: string;
  issuer: string;
  audience: string;
  requiredScopes: string[];
  metadataUrl: string;
  jwksUrl: string;
}

export interface CollabConfig {
  dbPath: string;
  maxChannelNameLength: number;
  maxMessageContentBytes: number;
  defaultReadLimit: number;
  maxReadLimit: number;
  defaultSubscriptionTtlMs: number;
  maxSubscriptionTtlMs: number;
  webhookTimeoutMs: number;
  webhookMaxAttempts: number;
  dispatcherIntervalMs: number;
  webhookSsrfEnabled: boolean;
  webhookSsrfAllowedHostnames: string[];
  webhookSsrfAllowedIpRanges: string[];
}

export interface AppConfig {
  host: string;
  port: number;
  authMode: AuthMode;
  staticBearerToken?: string;
  oauthJwt?: OAuthJwtConfig;
  publicBaseUrl?: string;
  resourceIdentifier?: string;
  allowedOrigins: string[];
  auditToStdout: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
  auditLogFile: string;
  auditMaxBytes: number;
  collab?: Partial<CollabConfig>;
}

export function resolveCollabConfig(config: AppConfig): CollabConfig {
  const defaultDbPath = config.auditLogFile.includes('/tmp/homelab-mcp/')
    ? join(homedir(), '.local', 'share', 'private_mcp', 'events.db')
    : join(dirname(config.auditLogFile), 'events.db');

  return {
    dbPath: config.collab?.dbPath ?? defaultDbPath,
    maxChannelNameLength: config.collab?.maxChannelNameLength ?? 64,
    maxMessageContentBytes: config.collab?.maxMessageContentBytes ?? 32 * 1024,
    defaultReadLimit: config.collab?.defaultReadLimit ?? 50,
    maxReadLimit: config.collab?.maxReadLimit ?? 200,
    defaultSubscriptionTtlMs: config.collab?.defaultSubscriptionTtlMs ?? 7 * 24 * 60 * 60 * 1000,
    maxSubscriptionTtlMs: config.collab?.maxSubscriptionTtlMs ?? 30 * 24 * 60 * 60 * 1000,
    webhookTimeoutMs: config.collab?.webhookTimeoutMs ?? 5000,
    webhookMaxAttempts: config.collab?.webhookMaxAttempts ?? 6,
    dispatcherIntervalMs: config.collab?.dispatcherIntervalMs ?? 2000,
    webhookSsrfEnabled: config.collab?.webhookSsrfEnabled ?? true,
    webhookSsrfAllowedHostnames: config.collab?.webhookSsrfAllowedHostnames ?? [],
    webhookSsrfAllowedIpRanges: config.collab?.webhookSsrfAllowedIpRanges ?? []
  };
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function parseAuthMode(value: string | undefined): AuthMode {
  const mode = (value ?? 'off').trim();
  if (mode === 'off' || mode === 'static_bearer' || mode === 'oauth_placeholder' || mode === 'oauth_jwt') return mode;
  throw new Error(`Invalid MCP_AUTH_MODE: ${mode}`);
}

function parseOrigins(value: string | undefined): string[] {
  const raw = value ?? 'http://127.0.0.1:8787,http://localhost:8787,https://chatgpt.com,https://gemini.google.com';
  return raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function parseCsv(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizeIssuer(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withScheme);
  url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function buildOAuthJwtConfig(
  env: NodeJS.ProcessEnv,
  publicBaseUrl: string | undefined,
  resourceIdentifier: string | undefined
): OAuthJwtConfig | undefined {
  const issuer = normalizeIssuer(env.OAUTH_ISSUER ?? env.AUTH0_ISSUER ?? env.AUTH0_DOMAIN);
  const audience = env.OAUTH_AUDIENCE?.trim() || env.AUTH0_AUDIENCE?.trim() || resourceIdentifier;
  const provider = env.OAUTH_PROVIDER?.trim() || (env.AUTH0_DOMAIN || env.AUTH0_ISSUER ? 'auth0' : 'generic_oidc');
  const requiredScopes = parseCsv(env.OAUTH_REQUIRED_SCOPES ?? env.AUTH0_REQUIRED_SCOPES, ['mcp:read']);

  if (!issuer || !audience || !resourceIdentifier || !publicBaseUrl) return undefined;

  const jwksUrl = env.OAUTH_JWKS_URI?.trim() || new URL('.well-known/jwks.json', issuer).toString();

  return {
    provider,
    issuer,
    audience,
    requiredScopes,
    metadataUrl: `${publicBaseUrl}/.well-known/oauth-protected-resource`,
    jwksUrl
  };
}

function parseSsrfHostnames(input: string | undefined): string[] {
  return parseCsv(input, []).map(raw => {
    const hostname = raw.toLowerCase().replace(/\.$/, '');
    const domain = hostname.startsWith('*.') ? hostname.slice(2) : hostname;
    if (!domain || !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
      throw new Error(`Invalid WEBHOOK_SSRF_ALLOWED_HOSTNAMES entry: ${raw}`);
    }
    return hostname;
  });
}

function parseSsrfCidrs(input: string | undefined): string[] {
  return parseCsv(input, []).map(value => {
    const [ip, prefix, extra] = value.split('/');
    const family = net.isIP(ip);
    const bits = family === 4 ? 32 : family === 6 ? 128 : 0;
    if (extra !== undefined || !bits || !/^(0|[1-9]\d*)$/.test(prefix ?? '') || Number(prefix) > bits) {
      throw new Error(`Invalid WEBHOOK_SSRF_ALLOWED_IP_RANGES entry: ${value}`);
    }
    return value;
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const host = env.HOST?.trim() || '127.0.0.1';
  const port = parsePort(env.PORT, 8787);
  const authMode = parseAuthMode(env.MCP_AUTH_MODE);
  const staticBearerToken = env.MCP_STATIC_BEARER_TOKEN?.trim() || undefined;
  const publicBaseUrl = env.MCP_PUBLIC_BASE_URL?.trim()
    ? trimTrailingSlash(env.MCP_PUBLIC_BASE_URL.trim())
    : undefined;
  const resourceIdentifier = env.MCP_RESOURCE_IDENTIFIER?.trim() || env.MCP_RESOURCE?.trim();
  const oauthJwt = buildOAuthJwtConfig(env, publicBaseUrl, resourceIdentifier);

  if (authMode === 'static_bearer' && !staticBearerToken) {
    throw new Error('MCP_AUTH_MODE=static_bearer requires MCP_STATIC_BEARER_TOKEN');
  }

  if (authMode === 'oauth_jwt' && !oauthJwt) {
    throw new Error(
      'MCP_AUTH_MODE=oauth_jwt requires MCP_PUBLIC_BASE_URL, MCP_RESOURCE_IDENTIFIER, OAUTH_ISSUER, and OAUTH_AUDIENCE. AUTH0_DOMAIN/AUTH0_AUDIENCE may be used as compatibility inputs.'
    );
  }

  if (host === '0.0.0.0') {
    throw new Error('Refusing to bind 0.0.0.0. Use HOST=127.0.0.1 and expose through a tunnel.');
  }

  const webhookSsrfEnabled = parseBoolean(env.WEBHOOK_SSRF_ENABLED, true);
  const webhookSsrfAllowedHostnames = parseSsrfHostnames(env.WEBHOOK_SSRF_ALLOWED_HOSTNAMES);
  const webhookSsrfAllowedIpRanges = parseSsrfCidrs(env.WEBHOOK_SSRF_ALLOWED_IP_RANGES);
  if (webhookSsrfEnabled && (webhookSsrfAllowedHostnames.length > 0) !== (webhookSsrfAllowedIpRanges.length > 0)) {
    throw new Error('WEBHOOK_SSRF_ALLOWED_HOSTNAMES and WEBHOOK_SSRF_ALLOWED_IP_RANGES must both be set for exceptions.');
  }

  const dbPath = env.PRIVATE_MCP_EVENTS_DB?.trim() || join(homedir(), '.local', 'share', 'private_mcp', 'events.db');

  return {
    host,
    port,
    authMode,
    staticBearerToken,
    oauthJwt,
    publicBaseUrl,
    resourceIdentifier,
    allowedOrigins: parseOrigins(env.MCP_ALLOWED_ORIGINS),
    auditToStdout: parseBoolean(env.AUDIT_TO_STDOUT, true),
    timeoutMs: parsePositiveInt(env.TIMEOUT_MS, 3000, 'TIMEOUT_MS'),
    maxOutputBytes: parsePositiveInt(env.MAX_OUTPUT_BYTES, 16 * 1024, 'MAX_OUTPUT_BYTES'),
    auditLogFile: env.AUDIT_LOG_FILE?.trim() || '/tmp/homelab-mcp/audit.jsonl',
    auditMaxBytes: parsePositiveInt(env.AUDIT_MAX_BYTES, 300 * 1024 * 1024, 'AUDIT_MAX_BYTES'),
    collab: {
      dbPath,
      webhookTimeoutMs: parsePositiveInt(env.WEBHOOK_TIMEOUT_MS, 5000, 'WEBHOOK_TIMEOUT_MS'),
      webhookMaxAttempts: parsePositiveInt(env.WEBHOOK_MAX_ATTEMPTS, 6, 'WEBHOOK_MAX_ATTEMPTS'),
      dispatcherIntervalMs: parsePositiveInt(env.WEBHOOK_DISPATCH_INTERVAL_MS, 2000, 'WEBHOOK_DISPATCH_INTERVAL_MS'),
      webhookSsrfEnabled,
      webhookSsrfAllowedHostnames,
      webhookSsrfAllowedIpRanges
    }
  };
}
