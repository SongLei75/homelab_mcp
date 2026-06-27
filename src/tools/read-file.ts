import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { AuditLogger } from '../audit/audit.js';
import { textOutputSchema, toolMeta, toolResult } from './schema.js';

export const readFileInputSchema = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().positive().optional()
}).strict();

export function createReadFileTool(audit: AuditLogger) {
  return {
    name: 'read_file',
    definition: {
      title: 'Read file',
      description: 'Read UTF-8 text from a local file.',
      inputSchema: readFileInputSchema,
      outputSchema: textOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      _meta: toolMeta()
    },
    handler: async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const requestId = randomUUID();
      const parsed = readFileInputSchema.parse(args ?? {});
      const content = await readFile(parsed.path);
      const maxBytes = parsed.maxBytes ?? content.length;
      const text = content.subarray(0, maxBytes).toString('utf8');
      await audit.write({
        requestId,
        event: 'tool.exec',
        decision: 'allow',
        toolName: 'read_file',
        tool: 'read_file',
        args: parsed,
        path: parsed.path
      });
      return toolResult({ text }, text);
    }
  };
}
