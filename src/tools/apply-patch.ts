import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { AuditLogger } from '../audit/audit.js';
import { execCommand } from '../exec/command.js';
import { commandOutputSchema, toolMeta, toolResult } from './schema.js';

export const applyPatchInputSchema = z.object({
  cwd: z.string().optional(),
  patch: z.string().min(1),
  strip: z.number().int().nonnegative().optional()
}).strict();

export function createApplyPatchTool(audit: AuditLogger) {
  return {
    name: 'apply_patch',
    definition: {
      title: 'Apply patch',
      description: 'Apply a unified diff using the system patch command.',
      inputSchema: applyPatchInputSchema,
      outputSchema: commandOutputSchema,
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
      const parsed = applyPatchInputSchema.parse(args ?? {});
      const patchPath = join(tmpdir(), `patch-${requestId}.diff`);
      await writeFile(patchPath, parsed.patch.endsWith('\n') ? parsed.patch : `${parsed.patch}\n`, 'utf8');
      const strip = parsed.strip ?? 1;
      const command = `patch -p${strip} < ${JSON.stringify(patchPath)}`;
      const result = await execCommand({
        command,
        cwd: parsed.cwd
      });
      await audit.write({
        requestId,
        event: 'tool.exec',
        decision: result.exitCode === 0 ? 'allow' : 'error',
        toolName: 'apply_patch',
        tool: 'apply_patch',
        args: parsed,
        cwd: parsed.cwd,
        command,
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated
      });
      return {
        ...toolResult({
          command,
          cwd: parsed.cwd,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated
        }, result.stdout || result.stderr || 'ok'),
        isError: result.exitCode !== 0,
      };
    }
  };
}
