import { randomUUID } from 'node:crypto';

import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { AuditLogger } from '../audit/audit.js';
import { checkToolCall } from '../policy/policy.js';
import { execFixedDate } from '../shell/exec-fixed.js';

export const runDateInputSchema = z.object({}).strict();

export function createRunDateTool(audit: AuditLogger) {
  return {
    name: 'run_date',
    definition: {
      title: 'Run local date',
      description: 'Return the local system date by executing the fixed `date` command. This tool accepts no arguments.',
      inputSchema: runDateInputSchema
    },
    handler: async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const requestId = randomUUID();
      const argumentsKeys = Object.keys(args ?? {});
      const policy = checkToolCall({
        requestId,
        toolName: 'run_date',
        fixedCommand: 'date',
        argumentsKeys
      });

      if (!policy.allow) {
        await audit.write({
          requestId,
          event: 'tool.policy',
          decision: 'deny',
          toolName: 'run_date',
          reason: policy.reason
        });
        return {
          isError: true,
          content: [{ type: 'text', text: `Denied by policy: ${policy.reason}` }]
        };
      }

      await audit.write({
        requestId,
        event: 'tool.policy',
        decision: 'allow',
        toolName: 'run_date'
      });

      try {
        const result = await execFixedDate();
        await audit.write({
          requestId,
          event: 'tool.exec',
          decision: result.exitCode === 0 ? 'allow' : 'error',
          toolName: 'run_date',
          durationMs: result.durationMs,
          exitCode: result.exitCode,
          reason: result.timedOut ? 'command timed out' : undefined
        });

        const payload = {
          command: 'date',
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: result.durationMs,
          timedOut: result.timedOut
        };

        return {
          isError: result.exitCode !== 0,
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await audit.write({
          requestId,
          event: 'tool.exec',
          decision: 'error',
          toolName: 'run_date',
          reason: message
        });
        return {
          isError: true,
          content: [{ type: 'text', text: `Execution error: ${message}` }]
        };
      }
    }
  };
}
