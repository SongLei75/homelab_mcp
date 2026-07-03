import { spawn } from 'node:child_process';
import { homedir, userInfo } from 'node:os';

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

const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

function getCurrentUserFallbacks(): { username?: string; home?: string } {
  try {
    const info = userInfo();
    return {
      username: info.username || undefined,
      home: info.homedir || undefined
    };
  } catch {
    const home = homedir();
    return {
      home: home || undefined
    };
  }
}

function createCommandEnv(): NodeJS.ProcessEnv {
  const fallback = getCurrentUserFallbacks();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: process.env.PATH || DEFAULT_PATH,
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || process.env.LANG || 'C.UTF-8',
    SHELL: process.env.SHELL || '/bin/bash'
  };

  env.HOME ||= fallback.home;
  env.USER ||= fallback.username;
  env.LOGNAME ||= env.USER || fallback.username;
  env.BASH_ENV ||= `${env.HOME}/.bashrc`;

  return env;
}

export function execCommand(options: CommandExecOptions): Promise<CommandExecResult> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const maxOutputBytes = options.maxOutputBytes ?? 16 * 1024;
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['-c', options.command], {
      cwd: options.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: createCommandEnv()
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
