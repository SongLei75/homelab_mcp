#!/usr/bin/env bash
set -euo pipefail

# Self-contained modern-protocol validation. No OAuth token or public port is needed:
# it exercises the same HTTP app in-process and starts the real stdio entrypoint.
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from './dist/http/app.js';
import { loadConfig } from './dist/config.js';

const tmp = await mkdtemp(join(tmpdir(), 'mcp-modern-validate-'));
const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'local-validate', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {}
};

function message(id, method, params = {}) {
  return { jsonrpc: '2.0', id, method, params: { _meta: meta, ...params } };
}

function headers(method, name) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'Mcp-Protocol-Version': '2026-07-28',
    'Mcp-Method': method,
    ...(name ? { 'Mcp-Name': name } : {})
  };
}

async function stdioSmoke() {
  const child = spawn(process.execPath, ['dist/stdio.js'], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', data => { stderr += data.toString(); });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('stdio modern-protocol test timed out: ' + stderr));
    }, 6000);
    let completed = false;

    child.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', code => {
      clearTimeout(timeout);
      if (completed && code === 0) resolve();
      else reject(new Error('stdio exited before tool result: ' + code + ' ' + stderr));
    });
    child.stdout.on('data', data => {
      buffer += data.toString();
      while (buffer.includes('\n')) {
        const separator = buffer.indexOf('\n');
        const line = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 1);
        if (!line) continue;
        let result;
        try {
          result = JSON.parse(line);
          assert.equal(result.jsonrpc, '2.0');
          if (result.id === 1) {
            assert.deepEqual(result.result.supportedVersions, ['2026-07-28']);
            child.stdin.write(JSON.stringify(message(2, 'tools/list')) + '\n');
          } else if (result.id === 2) {
            assert.deepEqual(result.result.tools.map(tool => tool.name), [
              'read_logs', 'read_file', 'write_file', 'apply_patch', 'run_command', 'send_file', 'recv_file'
            ]);
            child.stdin.write(JSON.stringify(message(3, 'tools/call', {
              name: 'run_command', arguments: { command: 'printf stdio-ok' }
            })) + '\n');
          } else if (result.id === 3) {
            assert.equal(result.result.structuredContent.stdout, 'stdio-ok');
            completed = true;
            child.stdin.end();
          }
        } catch (error) {
          clearTimeout(timeout);
          child.kill();
          reject(error);
        }
      }
    });
    child.stdin.write(JSON.stringify(message(1, 'server/discover')) + '\n');
  });
}

try {
  const config = {
    ...loadConfig({ ...process.env, MCP_AUTH_MODE: 'off' }),
    authMode: 'off',
    auditToStdout: false,
    auditLogFile: join(tmp, 'audit.jsonl')
  };
  const { app } = await createApp(config);

  async function rpc(id, method, params = {}) {
    const response = await app.request('/mcp', {
      method: 'POST',
      headers: headers(method, params.name),
      body: JSON.stringify(message(id, method, params))
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result.result;
  }

  const discovery = await rpc(1, 'server/discover');
  assert.deepEqual(discovery.supportedVersions, ['2026-07-28']);

  const listed = await rpc(2, 'tools/list');
  assert.deepEqual(listed.tools.map(tool => tool.name), [
    'read_logs', 'read_file', 'write_file', 'apply_patch', 'run_command', 'send_file', 'recv_file'
  ]);
  assert.deepEqual(listed.tools.find(tool => tool.name === 'send_file')._meta['openai/fileParams'], ['file']);

  async function call(id, name, args) {
    return rpc(id, 'tools/call', { name, arguments: args });
  }

  const file = join(tmp, 'test.txt');
  assert.equal((await call(3, 'write_file', { path: file, content: 'before\n' })).structuredContent.ok, true);
  assert.equal((await call(4, 'read_file', { path: file })).structuredContent.text, 'before\n');
  const patch = '--- a/test.txt\n+++ b/test.txt\n@@ -1 +1 @@\n-before\n+after\n';
  assert.equal((await call(5, 'apply_patch', { cwd: tmp, patch, strip: 1 })).structuredContent.exitCode, 0);
  assert.equal(await readFile(file, 'utf8'), 'after\n');
  assert.equal((await call(6, 'read_logs', { source: 'file', path: file, lines: 1 })).structuredContent.text, 'after');

  const [a, b] = await Promise.all([
    call(7, 'run_command', { command: 'sleep 0.15; printf A' }),
    call(7, 'run_command', { command: 'sleep 0.05; printf B' })
  ]);
  assert.equal(a.structuredContent.stdout, 'A');
  assert.equal(b.structuredContent.stdout, 'B');

  const received = await call(8, 'recv_file', { path: file });
  const resource = received.content.find(item => item.type === 'resource');
  assert.equal(Buffer.from(resource.resource.blob, 'base64').toString('utf8'), 'after\n');

  await stdioSmoke();
  console.log('OK: modern discover, seven HTTP and stdio tools, binary resource, concurrent isolation');
} finally {
  await rm(tmp, { recursive: true, force: true });
}
NODE
