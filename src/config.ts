export type AuthMode = 'off' | 'static_bearer' | 'oauth_placeholder';

export interface AppConfig {
  host: string;
  port: number;
  authMode: AuthMode;
  staticBearerToken?: string;
  allowedOrigins: string[];
  auditToStdout: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
  auditLogFile: string;
  auditMaxBytes: number;
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
  if (mode === 'off' || mode === 'static_bearer' || mode === 'oauth_placeholder') return mode;
  throw new Error(`Invalid MCP_AUTH_MODE: ${mode}`);
}

function parseOrigins(value: string | undefined): string[] {
  const raw = value ?? 'http://127.0.0.1:8787,http://localhost:8787,https://chatgpt.com';
  return raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const host = env.HOST?.trim() || '127.0.0.1';
  const port = parsePort(env.PORT, 8787);
  const authMode = parseAuthMode(env.MCP_AUTH_MODE);
  const staticBearerToken = env.MCP_STATIC_BEARER_TOKEN?.trim() || undefined;

  if (authMode === 'static_bearer' && !staticBearerToken) {
    throw new Error('MCP_AUTH_MODE=static_bearer requires MCP_STATIC_BEARER_TOKEN');
  }

  if (host === '0.0.0.0') {
    throw new Error('Refusing to bind 0.0.0.0. Use HOST=127.0.0.1 and expose through a tunnel.');
  }

  return {
    host,
    port,
    authMode,
    staticBearerToken,
    allowedOrigins: parseOrigins(env.MCP_ALLOWED_ORIGINS),
    auditToStdout: parseBoolean(env.AUDIT_TO_STDOUT, true),
    timeoutMs: parsePositiveInt(env.TIMEOUT_MS, 3000, 'TIMEOUT_MS'),
    maxOutputBytes: parsePositiveInt(env.MAX_OUTPUT_BYTES, 16 * 1024, 'MAX_OUTPUT_BYTES'),
    auditLogFile: env.AUDIT_LOG_FILE?.trim() || '/tmp/homelab-mcp/audit.jsonl',
    auditMaxBytes: parsePositiveInt(env.AUDIT_MAX_BYTES, 300 * 1024 * 1024, 'AUDIT_MAX_BYTES')
  };
}
