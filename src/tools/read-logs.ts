import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { AuditLogger } from '../audit/audit.js';
import { execCommand } from '../exec/command.js';
import { textOutputSchema, toolMeta, toolResult } from './schema.js';

function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  return bytes.subarray(0, maxBytes).toString('utf8');
}

export const readLogsInputSchema = z.object({
  source: z.enum(['journalctl', 'file']).optional(),
  user: z.boolean().optional(),
  unit: z.string().optional(),
  path: z.string().optional(),
  lines: z.number().int().positive().optional(),
  maxOutputBytes: z.number().int().positive().optional()
}).strict();

export function createReadLogsTool(audit: AuditLogger) {
  return {
    name: 'read_logs',
    definition: {
      title: 'Read logs',
      description: 'Read local journalctl output or tail a local log file.',
      inputSchema: readLogsInputSchema,
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
      const parsed = readLogsInputSchema.parse(args ?? {});
      const lines = parsed.lines ?? 200;
      const maxOutputBytes = parsed.maxOutputBytes ?? 16 * 1024;

      let text = '';
      if (parsed.source === 'journalctl') {
        const parts = ['journalctl'];
        if (parsed.user) parts.push('--user');
        if (parsed.unit) parts.push('-u', JSON.stringify(parsed.unit));
        parts.push('-n', String(lines), '--no-pager');
        const result = await execCommand({ command: parts.join(' '), maxOutputBytes });
        text = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`.trimEnd();
        text = truncateUtf8(text, maxOutputBytes);
      } else if (parsed.source === 'file' || parsed.path) {
        if (!parsed.path) {
          throw new Error('path is required when source=file');
        }
        const result = await execCommand({
          command: `tail -n ${lines} ${JSON.stringify(parsed.path)}`,
          maxOutputBytes
        });
        text = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`.trimEnd();
        text = truncateUtf8(text, maxOutputBytes);
      }

      await audit.write({
        requestId,
        event: 'tool.exec',
        decision: 'allow',
        toolName: 'read_logs',
        tool: 'read_logs',
        args: parsed,
        path: parsed.path
      });

      return toolResult({ text }, text);
    }
  };
}
