import { describe, expect, it } from 'vitest';

import { execFixedDate } from '../src/shell/exec-fixed.js';

describe('execFixedDate', () => {
  it('returns date output', async () => {
    const result = await execFixedDate({ timeoutMs: 3000, maxOutputBytes: 4096 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.timedOut).toBe(false);
  });
});
