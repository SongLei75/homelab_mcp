import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execCommandMock } = vi.hoisted(() => ({
  execCommandMock: vi.fn()
}));

vi.mock('../src/exec/command.js', () => ({
  execCommand: execCommandMock
}));

import { createReadLogsTool } from '../src/tools/read-logs.js';

const audit = { write: async () => undefined } as any;

describe('read_logs', () => {
  beforeEach(() => {
    execCommandMock.mockReset();
  });

  it('tails local files', async () => {
    execCommandMock.mockResolvedValue({
      stdout: 'line2\nline3\n',
      stderr: '',
      exitCode: 0,
      signal: null,
      durationMs: 1,
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false
    });

    const tool = createReadLogsTool(audit);
    const result = await tool.handler({ source: 'file', path: '/tmp/app.log', lines: 2, maxOutputBytes: 100 });

    expect(execCommandMock).toHaveBeenCalledWith({
      command: 'tail -n 2 "/tmp/app.log"',
      maxOutputBytes: 100
    });
    expect(result.content?.[0]).toMatchObject({ text: 'line2\nline3' });
  });

  it('constructs journalctl commands', async () => {
    execCommandMock.mockResolvedValue({
      stdout: 'journal',
      stderr: '',
      exitCode: 0,
      signal: null,
      durationMs: 1,
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false
    });

    const tool = createReadLogsTool(audit);
    await tool.handler({ source: 'journalctl', user: true, unit: 'mcp-local-gateway', lines: 5, maxOutputBytes: 100 });

    expect(execCommandMock).toHaveBeenCalledWith({
      command: 'journalctl --user -u "mcp-local-gateway" -n 5 --no-pager',
      maxOutputBytes: 100
    });
  });

  it('truncates output to maxOutputBytes', async () => {
    execCommandMock.mockResolvedValue({
      stdout: '1234567890',
      stderr: '',
      exitCode: 0,
      signal: null,
      durationMs: 1,
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false
    });

    const tool = createReadLogsTool(audit);
    const result = await tool.handler({ source: 'journalctl', maxOutputBytes: 4 });

    expect(result.content?.[0]).toMatchObject({ text: '1234' });
  });
});
