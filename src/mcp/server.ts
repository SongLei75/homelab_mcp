import { McpServer, ProtocolError } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { AuditLogger } from '../audit/audit.js';
import { createApplyPatchTool } from '../tools/apply-patch.js';
import { createReadFileTool } from '../tools/read-file.js';
import { createRecvFileTool } from '../tools/recv-file.js';
import { createReadLogsTool } from '../tools/read-logs.js';
import { createRunCommandTool } from '../tools/run-command.js';
import { createSendFileTool } from '../tools/send-file.js';
import { createWriteFileTool } from '../tools/write-file.js';
import { toolSecuritySchemes } from '../tools/schema.js';
import type { AppConfig } from '../config.js';
import type { McpRuntime } from './runtime.js';
import type { AuthContext } from '../auth/types.js';
import { hasScope } from '../auth/types.js';
import {
  createMessagePublishTool,
  createMessageReadTool,
  registerCollabResources
} from './collab.js';

type ToolRegistration = {
  name: string;
  requiredScope: string;
  definition: any;
  handler: any;
};

export function createMcpServer(
  audit: AuditLogger,
  config: AppConfig,
  auth?: AuthContext,
  runtime?: McpRuntime
): McpServer {
  const collab = runtime?.collab;
  const server = new McpServer(
    {
      name: 'private-mcp',
      title: 'My Computer',
      version: '0.1.0'
    },
    {
      capabilities: {
        resources: {
          subscribe: true
        },
        ...(runtime ? { events: {} } : {})
      } as any
    }
  );

  const tools: ToolRegistration[] = [
    { ...createReadLogsTool(audit), requiredScope: 'mcp:read' },
    { ...createReadFileTool(audit), requiredScope: 'mcp:read' },
    { ...createWriteFileTool(audit), requiredScope: 'mcp:write' },
    { ...createApplyPatchTool(audit), requiredScope: 'mcp:write' },
    { ...createRunCommandTool(audit, config), requiredScope: 'mcp:command' },
    { ...createSendFileTool(audit), requiredScope: 'mcp:write' },
    { ...createRecvFileTool(audit), requiredScope: 'mcp:read' }
  ];

  if (collab) {
    tools.push(
      { ...createMessagePublishTool(audit, collab, auth), requiredScope: 'mcp:write' },
      { ...createMessageReadTool(audit, collab, auth), requiredScope: 'mcp:read' }
    );
  }

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

    const securitySchemes = toolSecuritySchemes(config.authMode, tool.requiredScope);
    server.registerTool(tool.name, {
      ...tool.definition,
      // SDK 2.3.1 serializes OpenAI's securitySchemes compatibility extension in _meta.
      _meta: securitySchemes ? { ...tool.definition._meta, securitySchemes } : tool.definition._meta
    }, tool.handler);
  }

  if (collab && (config.authMode !== 'oauth_jwt' || hasScope(auth, 'mcp:read'))) {
    registerCollabResources(server, collab);
  }

  if (runtime) {
    // MCP Events extension lives in the MCP server, never in a transport adapter.
    for (const method of ['events/list', 'events/subscribe', 'events/unsubscribe'] as const) {
      server.server.setRequestHandler(method, { params: z.object({}).passthrough() }, async params => {
        const response = await runtime.eventsRpc.handleRpc({ jsonrpc: '2.0', method, params }, auth);
        if (response.error) throw new ProtocolError(response.error.code, response.error.message, response.error.data);
        return response.result as Record<string, unknown>;
      });
    }
  }

  return server;
}
