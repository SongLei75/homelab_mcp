import { mkdir, appendFile, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { AppConfig } from '../config.js';

export type AuditDecision = 'allow' | 'deny' | 'error' | 'info';

export interface AuditEvent {
  timestamp: string;
  requestId: string;
  event: string;
  decision?: AuditDecision;
  toolName?: string;
  reason?: string;
  tool?: string;
  args?: unknown;
  path?: string;
  cwd?: string;
  command?: string;
  durationMs?: number;
  exitCode?: number | null;
  timedOut?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  origin?: string | null;
  authMode?: string;
  remoteAddr?: string | null;
}

export class AuditLogger {
  constructor(private readonly config: AppConfig) {}

  async write(event: Omit<AuditEvent, 'timestamp'>): Promise<void> {
    const payload: AuditEvent = {
      timestamp: new Date().toISOString(),
      ...event
    };
    const line = `${JSON.stringify(payload)}\n`;

    if (this.config.auditToStdout) {
      process.stdout.write(line);
    }

    if (this.config.auditLogFile) {
      await this.writeToFile(line);
    }
  }

  private async writeToFile(line: string): Promise<void> {
    const file = this.config.auditLogFile;
    await mkdir(dirname(file), { recursive: true });

    try {
      await appendFile(file, line, 'utf8');
      const current = await stat(file);
      if (current.size > this.config.auditMaxBytes) {
        const content = await readFile(file);
        const tail = content.subarray(Math.max(0, content.length - this.config.auditMaxBytes));
        await writeFile(file, tail);
      }
    } catch {
      await writeFile(file, line, 'utf8');
    }
  }
}
