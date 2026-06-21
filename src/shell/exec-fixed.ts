import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface FixedExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
}

export interface FixedExecOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

function getDateBinary(): string {
  if (existsSync('/usr/bin/date')) return '/usr/bin/date';
  if (existsSync('/bin/date')) return '/bin/date';
  return 'date';
}

export function execFixedDate(options: FixedExecOptions = {}): Promise<FixedExecResult> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const maxOutputBytes = options.maxOutputBytes ?? 16 * 1024;
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(getDateBinary(), [], {
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
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout = Buffer.concat([stdout, Buffer.from(chunk)]).subarray(0, maxOutputBytes);
    });

    child.stderr.on('data', chunk => {
      stderr = Buffer.concat([stderr, Buffer.from(chunk)]).subarray(0, maxOutputBytes);
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
        timedOut
      });
    });
  });
}
