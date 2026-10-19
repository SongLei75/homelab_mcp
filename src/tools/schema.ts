import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AuthMode } from '../config.js';

/** OpenAI tool authentication metadata varies by transport and tool scope. */
export function toolSecuritySchemes(authMode: AuthMode, requiredScope: string) {
  if (authMode === 'off') return [{ type: 'noauth' }] as const;
  if (authMode === 'oauth_jwt') return [{ type: 'oauth2', scopes: [requiredScope] }] as const;
  // Do not claim that static-bearer or placeholder tools allow anonymous access.
  return undefined;
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

