import 'dotenv/config';

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { AuditLogger } from './audit/audit.js';
import { loadConfig } from './config.js';
import { createMcpServer } from './mcp/server.js';

// The stdio transport is the local/OpenAI-tunnel management channel.
// It intentionally does not use HTTP OAuth/JWT auth. Public OAuth-protected
// access is handled by src/index.ts through the HTTP transport.
//
// Force auth off here so a shell-loaded OAuth env file cannot accidentally
// scope-gate or break the management transport.
const config = {
  ...loadConfig({ ...process.env, MCP_AUTH_MODE: 'off' }),
  auditToStdout: false,
  authMode: 'off' as const
};
const audit = new AuditLogger(config);

console.error('mcp-local-gateway stdio transport starting');

serveStdio(() => createMcpServer(audit, config), { legacy: 'reject' });
