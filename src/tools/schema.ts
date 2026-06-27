import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

export const noAuthSecuritySchemes = [{ type: 'noauth' }] as const;

export function toolMeta() {
  return {
    securitySchemes: noAuthSecuritySchemes
  };
}

export function toolResult<T extends Record<string, unknown>>(output: T, text?: string): CallToolResult {
  return {
    content: [{ type: 'text', text: text ?? JSON.stringify(output, null, 2) }],
    structuredContent: output
  };
}

export const textOutputSchema = z.object({
  text: z.string()
}).strict();

export const okOutputSchema = z.object({
  ok: z.boolean()
}).strict();

export const commandOutputSchema = z.object({
  command: z.string(),
  cwd: z.string().optional(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
  timedOut: z.boolean(),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean()
}).strict();

