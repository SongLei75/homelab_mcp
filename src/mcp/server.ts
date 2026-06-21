import { McpServer } from '@modelcontextprotocol/server';

import { AuditLogger } from '../audit/audit.js';
import { createRunDateTool } from '../tools/run-date.js';

export function createMcpServer(audit: AuditLogger): McpServer {
  const server = new McpServer({
    name: 'mcp-local-gateway',
    version: '0.1.0'
  });

  const runDate = createRunDateTool(audit);
  server.registerTool(runDate.name, runDate.definition, runDate.handler);

  return server;
}
