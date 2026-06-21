import { McpServer } from '@modelcontextprotocol/server';

import { AuditLogger } from '../audit/audit.js';
import { createApplyPatchTool } from '../tools/apply-patch.js';
import { createReadFileTool } from '../tools/read-file.js';
import { createReadLogsTool } from '../tools/read-logs.js';
import { createRunCommandTool } from '../tools/run-command.js';
import { createWriteFileTool } from '../tools/write-file.js';
import type { AppConfig } from '../config.js';

export function createMcpServer(audit: AuditLogger, config: AppConfig): McpServer {
  const server = new McpServer({
    name: 'mcp-local-gateway',
    version: '0.1.0'
  });

  for (const tool of [
    createReadLogsTool(audit),
    createReadFileTool(audit),
    createWriteFileTool(audit),
    createApplyPatchTool(audit),
    createRunCommandTool(audit, config)
  ] as Array<{ name: string; definition: any; handler: any }>) {
    server.registerTool(tool.name, tool.definition, tool.handler);
  }

  return server;
}
