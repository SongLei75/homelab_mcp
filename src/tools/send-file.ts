import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, mkdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { AuditLogger } from '../audit/audit.js';
import { toolResult } from './schema.js';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const DOWNLOAD_TIMEOUT_MS = 120_000;

const openAiFileSchema = z.object({
  download_url: z.string(),
  file_id: z.string(),
  mime_type: z.string().optional(),
  file_name: z.string().optional()
}).strict();

export const sendFileInputSchema = z.object({
  file: openAiFileSchema,
  destination: z.string().min(1),
  overwrite: z.boolean().optional(),
  createParentDirs: z.boolean().optional(),
  expectedSha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional()
}).strict();

const sendFileOutputSchema = z.object({
  path: z.string(),
  fileName: z.string(),
  fileId: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string()
}).strict();

function validateDownloadUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const trusted = host === 'oaiusercontent.com'
    || host.endsWith('.oaiusercontent.com')
    || /^oaisdmntpr[a-z0-9-]+\.blob\.core\.windows\.net$/.test(host);
  if (!trusted || url.protocol !== 'https:' || url.port || url.username || url.password) {
    throw new Error('The file download address is not an approved OpenAI HTTPS host');
  }
  return url;
}

async function getFileResponse(value: string, signal: AbortSignal): Promise<Response> {
  let url = validateDownloadUrl(value);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await fetch(url, { redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === MAX_REDIRECTS) throw new Error('Too many file download redirects');
      const location = response.headers.get('location');
      if (!location) throw new Error('File download redirect has no location');
      await response.body?.cancel();
      url = validateDownloadUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok || !response.body) throw new Error('OpenAI file download failed: HTTP ' + response.status);
    const declared = response.headers.get('content-length');
    if (declared && Number(declared) > MAX_FILE_BYTES) {
      await response.body.cancel();
      throw new Error('File exceeds the 50 MiB transfer limit');
    }
    return response;
  }
  throw new Error('Too many file download redirects');
}

export function createSendFileTool(audit: AuditLogger) {
  return {
    name: 'send_file',
    definition: {
      title: 'Send file to my computer',
      description: 'Copy a ChatGPT-provided file to this computer. Use the native OpenAI file input; do not copy file bytes into text arguments. Existing files are never replaced unless overwrite is true. Maximum file size is 50 MiB.',
      inputSchema: sendFileInputSchema,
      outputSchema: sendFileOutputSchema,
      _meta: { 'openai/fileParams': ['file'] },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    handler: async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const parsed = sendFileInputSchema.parse(args ?? {});
      const destination = parsed.destination;
      if (basename(destination) === '.' || basename(destination) === '..') {
        throw new Error('Destination must name a file');
      }
      if (parsed.createParentDirs) await mkdir(dirname(destination), { recursive: true });

      const temporary = join(dirname(destination), '.' + basename(destination) + '.' + randomUUID() + '.part');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
      const hash = createHash('sha256');
      let bytes = 0;

      try {
        const response = await getFileResponse(parsed.file.download_url, controller.signal);
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > MAX_FILE_BYTES) {
              callback(new Error('File exceeds the 50 MiB transfer limit'));
              return;
            }
            hash.update(chunk);
            callback(null, chunk);
          }
        });
        await pipeline(Readable.fromWeb(response.body as any), meter, createWriteStream(temporary, {
          flags: 'wx',
          mode: 0o600
        }));
        const sha256 = hash.digest('hex');
        if (parsed.expectedSha256 && sha256 !== parsed.expectedSha256.toLowerCase()) {
          throw new Error('File SHA-256 verification failed');
        }
        if (parsed.overwrite) {
          await rename(temporary, destination);
        } else {
          await link(temporary, destination);
          await unlink(temporary);
        }
        await audit.write({
          requestId: randomUUID(),
          event: 'tool.exec',
          decision: 'allow',
          toolName: 'send_file',
          tool: 'send_file',
          path: destination
        });
        return toolResult({
          path: destination,
          fileName: parsed.file.file_name || basename(destination),
          fileId: parsed.file.file_id,
          bytes,
          sha256
        });
      } finally {
        clearTimeout(timer);
        await unlink(temporary).catch(() => undefined);
      }
    }
  };
}
