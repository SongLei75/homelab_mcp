import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { AuditLogger } from '../audit/audit.js';
import { okOutputSchema, toolMeta, toolResult } from './schema.js';

export const writeFileInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  createParentDirs: z.boolean().optional()
}).strict();

export function createWriteFileTool(audit: AuditLogger) {
  return {
    name: 'write_file',
    definition: {
      title: 'Write file',
      description: 'Write UTF-8 text to a local file.',
      inputSchema: writeFileInputSchema,
      outputSchema: okOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      },
      _meta: toolMeta()
    },
    handler: async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const requestId = randomUUID();
      const parsed = writeFileInputSchema.parse(args ?? {});
      if (parsed.createParentDirs) {
        await mkdir(dirname(parsed.path), { recursive: true });
      }
      await writeFile(parsed.path, parsed.content, 'utf8');
      await audit.write({
        requestId,
        event: 'tool.exec',
        decision: 'allow',
        toolName: 'write_file',
        tool: 'write_file',
        args: parsed,
        path: parsed.path
      });
      return toolResult({ ok: true }, 'ok');
    }
  };
}
