#!/usr/bin/env bash
set -euo pipefail

# Self-contained modern-protocol validation. No OAuth token or public port is needed:
# it exercises the single HTTP backend in-process.
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from './dist/http/app.js';
import { loadConfig } from './dist/config.js';

const tmp = await mkdtemp(join(tmpdir(), 'mcp-modern-validate-'));
let closeApp;
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


try {
  const config = {
    ...loadConfig({ ...process.env, MCP_AUTH_MODE: 'off', PLAYWRIGHT_MCP_ENABLED: 'false' }),
    authMode: 'off',
    auditToStdout: false,
    auditLogFile: join(tmp, 'audit.jsonl'),
    collab: { dbPath: join(tmp, 'http-events.db') }
  };
  const { app, close } = await createApp(config);
  closeApp = close;

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
    'read_logs', 'read_file', 'write_file', 'apply_patch', 'run_command', 'send_file', 'recv_file', 'message_publish', 'message_read'
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

  console.log('OK: modern HTTP discover, nine core tools, binary resource, concurrent isolation');
} finally {
  closeApp?.();
  await rm(tmp, { recursive: true, force: true });
}
NODE
