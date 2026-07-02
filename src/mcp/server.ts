import { McpServer } from '@modelcontextprotocol/server';

import { AuditLogger } from '../audit/audit.js';
import { createApplyPatchTool } from '../tools/apply-patch.js';
import { createReadFileTool } from '../tools/read-file.js';
import { createReadLogsTool } from '../tools/read-logs.js';
import { createRunCommandTool } from '../tools/run-command.js';
import { createWriteFileTool } from '../tools/write-file.js';
import type { AppConfig } from '../config.js';
import type { AuthContext } from '../auth/types.js';
import { hasScope } from '../auth/types.js';

type ToolRegistration = {
  name: string;
  requiredScope: string;
  definition: any;
  handler: any;
};

export function createMcpServer(audit: AuditLogger, config: AppConfig, auth?: AuthContext): McpServer {
  const server = new McpServer({
    name: 'mcp-local-gateway',
    version: '0.1.0'
  });

  const tools: ToolRegistration[] = [
    { ...createReadLogsTool(audit), requiredScope: 'mcp:read' },
    { ...createReadFileTool(audit), requiredScope: 'mcp:read' },
    { ...createWriteFileTool(audit), requiredScope: 'mcp:write' },
    { ...createApplyPatchTool(audit), requiredScope: 'mcp:write' },
    { ...createRunCommandTool(audit, config), requiredScope: 'mcp:command' }
  ];

  for (const tool of tools) {
    if (config.authMode === 'oauth_jwt' && !hasScope(auth, tool.requiredScope)) {
      void audit.write({
        requestId: 'tool-registration',
        event: 'tool.register',
        decision: 'deny',
        reason: 'scope missing for tool registration',
        toolName: tool.name,
        tool: tool.name,
        requiredScope: tool.requiredScope,
        subject: auth?.subject,
        scopes: auth?.scopes ?? []
      });
      continue;
    }

    server.registerTool(tool.name, tool.definition, tool.handler);
  }

  return server;
}
