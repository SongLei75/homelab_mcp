import { mkdir, appendFile } from 'node:fs/promises';
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
  durationMs?: number;
  exitCode?: number | null;
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
      await mkdir(dirname(this.config.auditLogFile), { recursive: true });
      await appendFile(this.config.auditLogFile, line, 'utf8');
    }
  }
}
