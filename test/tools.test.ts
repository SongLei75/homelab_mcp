import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createApplyPatchTool } from '../src/tools/apply-patch.js';
import { createReadFileTool } from '../src/tools/read-file.js';
import { createReadLogsTool } from '../src/tools/read-logs.js';
import { createRunCommandTool } from '../src/tools/run-command.js';
import { createWriteFileTool } from '../src/tools/write-file.js';

const audit = { write: async () => undefined } as any;

describe('tools', () => {
  it('reads, writes, patches, logs, and runs commands', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tools-test-'));
    const file = join(dir, 'hello.txt');
    await createWriteFileTool(audit).handler({ path: file, content: 'hello', createParentDirs: true });
    const read = await createReadFileTool(audit).handler({ path: file, maxBytes: 10 });
    expect(read.content?.[0]).toMatchObject({ type: 'text', text: 'hello' });

    await writeFile(join(dir, 'patch-target.txt'), 'old\n', 'utf8');
    const patch = [
      '--- a/patch-target.txt',
      '+++ b/patch-target.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new'
    ].join('\n');
    await createApplyPatchTool(audit).handler({ cwd: dir, patch, strip: 1 });
    expect(await readFile(join(dir, 'patch-target.txt'), 'utf8')).toContain('new');

    const run = await createRunCommandTool(audit, {
      host: '127.0.0.1',
      port: 8787,
      authMode: 'off',
      allowedOrigins: [],
      auditToStdout: false,
      timeoutMs: 2000,
      maxOutputBytes: 4096,
      auditLogFile: join(dir, 'audit.jsonl'),
      auditMaxBytes: 1024 * 1024
    }).handler({ command: 'printf run' });
    expect(run.content?.[0]).toMatchObject({ type: 'text' });

    await writeFile(join(dir, 'audit.log'), 'one\ntwo\nthree\n', 'utf8');
    const logs = await createReadLogsTool(audit).handler({ path: join(dir, 'audit.log'), lines: 2 });
    expect(logs.content?.[0]).toMatchObject({ type: 'text', text: 'two\nthree' });
  });
});
