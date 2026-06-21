import { randomUUID } from 'node:crypto';

import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { AuditLogger } from '../audit/audit.js';
import { checkToolCall } from '../policy/policy.js';
import { execCommand } from '../exec/command.js';
import type { AppConfig } from '../config.js';

export const runCommandInputSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxOutputBytes: z.number().int().positive().optional()
}).strict();

export function createRunCommandTool(audit: AuditLogger, config: AppConfig) {
  return {
    name: 'run_command',
    definition: {
      title: 'Run command',
      description: 'Execute a local command through /bin/bash -lc.',
      inputSchema: runCommandInputSchema
    },
    handler: async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const requestId = randomUUID();
      const parsed = runCommandInputSchema.safeParse(args ?? {});

      if (!parsed.success) {
        await audit.write({
          requestId,
          event: 'tool.policy',
          decision: 'deny',
          toolName: 'run_command',
          tool: 'run_command',
          args,
          reason: 'invalid arguments'
        });
        return { isError: true, content: [{ type: 'text', text: 'Invalid arguments' }] };
      }

      const policy = checkToolCall({
        requestId,
        toolName: 'run_command',
        command: parsed.data.command,
        args: parsed.data
      });

      await audit.write({
        requestId,
        event: 'tool.policy',
        decision: policy.allow ? 'allow' : 'deny',
        toolName: 'run_command',
        tool: 'run_command',
        args: parsed.data
      });

      const result = await execCommand({
        command: parsed.data.command,
        cwd: parsed.data.cwd,
        timeoutMs: parsed.data.timeoutMs ?? config.timeoutMs,
        maxOutputBytes: parsed.data.maxOutputBytes ?? config.maxOutputBytes
      });

      await audit.write({
        requestId,
        event: 'tool.exec',
        decision: result.exitCode === 0 ? 'allow' : 'error',
        toolName: 'run_command',
        tool: 'run_command',
        args: parsed.data,
        cwd: parsed.data.cwd,
        command: parsed.data.command,
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated
      });

      return {
        isError: result.exitCode !== 0,
        content: [{
          type: 'text',
          text: JSON.stringify({
            command: parsed.data.command,
            cwd: parsed.data.cwd,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            signal: result.signal,
            durationMs: result.durationMs,
            timedOut: result.timedOut,
            stdoutTruncated: result.stdoutTruncated,
            stderrTruncated: result.stderrTruncated
          }, null, 2)
        }]
      };
    }
  };
}
