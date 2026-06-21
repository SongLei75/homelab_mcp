import 'dotenv/config';

import { StdioServerTransport } from '@modelcontextprotocol/server';

import { AuditLogger } from './audit/audit.js';
import { loadConfig } from './config.js';
import { createMcpServer } from './mcp/server.js';

const config = loadConfig();
const audit = new AuditLogger(config);
const server = createMcpServer(audit, config);
const transport = new StdioServerTransport();

console.error('mcp-local-gateway stdio transport starting');

await server.connect(transport);
