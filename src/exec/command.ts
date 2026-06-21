import { spawn } from 'node:child_process';

export interface CommandExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface CommandExecOptions {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export function execCommand(options: CommandExecOptions): Promise<CommandExecResult> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const maxOutputBytes = options.maxOutputBytes ?? 16 * 1024;
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['-lc', options.command], {
      cwd: options.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        LANG: process.env.LANG ?? 'C.UTF-8',
        LC_ALL: process.env.LC_ALL ?? 'C.UTF-8'
      }
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      if (stdout.length >= maxOutputBytes) {
        stdoutTruncated = true;
        return;
      }
      const next = Buffer.concat([stdout, Buffer.from(chunk)]);
      stdoutTruncated ||= next.length > maxOutputBytes;
      stdout = next.subarray(0, maxOutputBytes);
    });

    child.stderr.on('data', chunk => {
      if (stderr.length >= maxOutputBytes) {
        stderrTruncated = true;
        return;
      }
      const next = Buffer.concat([stderr, Buffer.from(chunk)]);
      stderrTruncated ||= next.length > maxOutputBytes;
      stderr = next.subarray(0, maxOutputBytes);
    });

    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        exitCode,
        signal,
        durationMs: Date.now() - startedAt,
        timedOut,
        stdoutTruncated,
        stderrTruncated
      });
    });
  });
}
