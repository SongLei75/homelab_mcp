import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AuditLogger } from '../src/audit/audit.js';

describe('AuditLogger', () => {
  it('rotates when max bytes are exceeded', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-test-'));
    const logger = new AuditLogger({
      host: '127.0.0.1',
      port: 8787,
      authMode: 'off',
      allowedOrigins: [],
      auditToStdout: false,
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      auditLogFile: join(dir, 'audit.jsonl'),
      auditMaxBytes: 200
    });

    for (let i = 0; i < 20; i += 1) {
      await logger.write({
        requestId: `r${i}`,
        event: 'tool.exec',
        toolName: 'run_command',
        tool: 'run_command',
        args: { i },
        command: 'printf x'
      });
    }

    const files = await readdir(dir);
    expect(files.length).toBeGreaterThan(0);
    const current = await stat(join(dir, 'audit.jsonl'));
    expect(current.size).toBeLessThanOrEqual(200);
    const text = await readFile(join(dir, 'audit.jsonl'), 'utf8');
    expect(text).toContain('"tool":"run_command"');
  });
});
