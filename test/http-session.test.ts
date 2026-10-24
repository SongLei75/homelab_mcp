import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createApp } from '../src/http/app.js';
import type { AppConfig } from '../src/config.js';

function testConfig(auditLogFile: string, allowedOrigins: string[] = []): AppConfig {
  return {
    host: '127.0.0.1',
    port: 8787,
    authMode: 'off',
    allowedOrigins,
    auditToStdout: false,
    timeoutMs: 3000,
    maxOutputBytes: 4096,
    auditLogFile,
    auditMaxBytes: 1024 * 1024
  };
}

const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'migration-test', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {}
};

function headers(method: string, name?: string): Record<string, string> {
  return {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'Mcp-Protocol-Version': '2026-07-28',
    'Mcp-Method': method,
    ...(name ? { 'Mcp-Name': name } : {})
  };
}

function request(id: number, method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params: { _meta: meta, ...params } });
}

async function rpc(
  app: Awaited<ReturnType<typeof createApp>>['app'],
  id: number,
  method: string,
  params: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {}
) {
  const response = await app.request('/mcp', {
    method: 'POST',
    headers: { ...headers(method, typeof params.name === 'string' ? params.name : undefined), ...extraHeaders },
    body: request(id, method, params)
  });
  return { status: response.status, headers: response.headers, body: await response.json() as any };
}

describe('Modern HTTP MCP protocol', () => {
  it('supports server/discover and lists exactly seven tools without a session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-modern-discover-'));
    const { app } = await createApp(testConfig(join(dir, 'audit.jsonl')));

    const discover = await rpc(app, 1, 'server/discover');
    expect(discover.status).toBe(200);
    expect(discover.body.result.supportedVersions).toEqual(['2026-07-28']);
    expect(discover.headers.get('mcp-session-id')).toBeNull();

    const health = await app.request('/healthz');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ name: 'private-mcp' });

    const list = await rpc(app, 2, 'tools/list');
    expect(list.status).toBe(200);
    expect((list.body.result.tools as any[]).map(tool => tool.name)).toEqual([
      'read_logs', 'read_file', 'write_file', 'apply_patch', 'run_command', 'send_file', 'recv_file'
    ]);

    const sendFile = list.body.result.tools.find((tool: any) => tool.name === 'send_file');
    expect(sendFile._meta['openai/fileParams']).toEqual(['file']);
    expect(sendFile._meta.securitySchemes).toEqual([{ type: 'noauth' }]);
    const runCommand = list.body.result.tools.find((tool: any) => tool.name === 'run_command');
    expect(runCommand.outputSchema).toMatchObject({
      type: 'object',
      properties: {
        stdout: { type: 'string' },
        exitCode: { anyOf: expect.arrayContaining([
          expect.objectContaining({ type: 'integer' }),
          expect.objectContaining({ type: 'null' })
        ]) }
      }
    });
    expect(runCommand.annotations).toMatchObject({
      readOnlyHint: false, destructiveHint: true, openWorldHint: true
    });
    for (const tool of list.body.result.tools as any[]) {
      expect(tool._meta.securitySchemes).toEqual([{ type: 'noauth' }]);
    }
  });

  it('isolates two concurrent tools/call requests even with the same request ID', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-modern-concurrency-'));
    const { app } = await createApp(testConfig(join(dir, 'audit.jsonl')));

    const [a, b] = await Promise.all([
      rpc(app, 7, 'tools/call', {
        name: 'run_command',
        arguments: { command: 'sleep 0.2; printf isolated-A', timeoutMs: 3000 }
      }),
      rpc(app, 7, 'tools/call', {
        name: 'run_command',
        arguments: { command: 'sleep 0.1; printf isolated-B', timeoutMs: 3000 }
      })
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.result.structuredContent.stdout).toBe('isolated-A');
    expect(b.body.result.structuredContent.stdout).toBe('isolated-B');
    expect(a.headers.get('mcp-session-id')).toBeNull();
  });

  it('preserves request correlation with tool execution without logging OpenAI identity headers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-modern-correlation-'));
    const auditLogFile = join(dir, 'audit.jsonl');
    const { app } = await createApp(testConfig(auditLogFile));
    const openAiSession = 'debug-openai-session-value';

    const result = await rpc(app, 9, 'tools/call', {
      name: 'run_command',
      arguments: { command: 'printf correlation-ok', timeoutMs: 3000 }
    }, {
      'X-OpenAI-Session': openAiSession,
      'X-OpenAI-Subject': 'debug-openai-subject-value',
      'Cf-Ray': 'debug-ray'
    });
    expect(result.status).toBe(200);
    expect(result.body.result.structuredContent.stdout).toBe('correlation-ok');

    const events = (await readFile(auditLogFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const httpRequest = events.find((event: any) =>
      event.event === 'mcp.http.request' && event.rpcMethods?.includes('tools/call')
    );
    const toolExec = events.find((event: any) =>
      event.event === 'tool.exec' && event.toolName === 'run_command'
    );

    expect(httpRequest).toMatchObject({
      rpcIds: ['number:9'], rpcMethods: ['tools/call'], cfRay: 'debug-ray'
    });
    expect(httpRequest.openaiSessionHash).toMatch(/^[a-f0-9]{16}$/);
    expect(httpRequest.openaiSubjectHash).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(httpRequest)).not.toContain(openAiSession);
    expect(toolExec.requestId).toBe(httpRequest.requestId);
    expect(toolExec.executionId).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('supports the legacy initialization handshake', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-modern-rejection-'));
    const { app } = await createApp(testConfig(join(dir, 'audit.jsonl')));
    const response = await app.request('/mcp', {
      method: 'POST',
      headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'Mcp-Protocol-Version': '2025-06-18' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old', version: '1' } }
      })
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('2025-06-18');
  });

  it('uses configured allowed origins for CORS responses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-modern-cors-'));
    const { app } = await createApp(testConfig(join(dir, 'audit.jsonl'), ['https://chatgpt.com']));

    const allowed = await app.request('/mcp', {
      method: 'OPTIONS',
      headers: { Origin: 'https://chatgpt.com', 'Access-Control-Request-Method': 'POST' }
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://chatgpt.com');

    const denied = await app.request('/mcp', {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'POST' }
    });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });
});
