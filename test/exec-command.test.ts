import { describe, expect, it } from 'vitest';

import { execCommand } from '../src/exec/command.js';

describe('execCommand', () => {
  it('runs a command and captures output', async () => {
    const result = await execCommand({ command: 'printf hello', timeoutMs: 2000, maxOutputBytes: 4096 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello');
    expect(result.timedOut).toBe(false);
  });

  it('reports truncation', async () => {
    const result = await execCommand({ command: 'printf 1234567890', timeoutMs: 2000, maxOutputBytes: 4 });
    expect(result.stdout).toBe('1234');
    expect(result.stdoutTruncated).toBe(true);
  });
});
