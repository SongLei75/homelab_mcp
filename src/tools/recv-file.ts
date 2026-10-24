import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { AuditLogger } from '../audit/audit.js';

const MAX_INLINE_BYTES = 2 * 1024 * 1024;

export const recvFileInputSchema = z.object({
  path: z.string().min(1)
}).strict();

const recvFileOutputSchema = z.object({
  path: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string()
}).strict();

function mimeType(path: string): string {
  const types: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.zip': 'application/zip',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  };
  return types[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export function createRecvFileTool(audit: AuditLogger) {
  return {
    name: 'recv_file',
    definition: {
      title: 'Receive file from my computer',
      description: 'Read a binary file from this computer and return it as an MCP embedded resource. Maximum 2 MiB per call; this does not automatically save the file to the ChatGPT Library.',
      inputSchema: recvFileInputSchema,
      outputSchema: recvFileOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    handler: async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const { path } = recvFileInputSchema.parse(args ?? {});
      const info = await stat(path);
      if (!info.isFile()) throw new Error('Source must be a regular file');
      if (info.size > MAX_INLINE_BYTES) throw new Error('File exceeds the 2 MiB inline transfer limit');
      const data = await readFile(path);
      if (data.length > MAX_INLINE_BYTES) throw new Error('File exceeds the 2 MiB inline transfer limit');

      const details = {
        path,
        fileName: basename(path),
        mimeType: mimeType(path),
        bytes: data.length,
        sha256: createHash('sha256').update(data).digest('hex')
      };
      await audit.write({
        requestId: randomUUID(),
        event: 'tool.exec',
        decision: 'allow',
        toolName: 'recv_file',
        tool: 'recv_file',
        path
      });
      return {
        structuredContent: details,
        content: [
          { type: 'text', text: 'Binary file returned as an embedded MCP resource: ' + details.fileName },
          { type: 'resource', resource: {
            uri: pathToFileURL(path).href,
            mimeType: details.mimeType,
            blob: data.toString('base64')
          } }
        ]
      };
    }
  };
}
