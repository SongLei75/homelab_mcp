import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createApp } from '../src/http/app.js';
import type { AppConfig } from '../src/config.js';

function testConfig(auditLogFile: string): AppConfig {
  return {
    host: '127.0.0.1',
    port: 8787,
    authMode: 'off',
    allowedOrigins: [],
    auditToStdout: false,
    timeoutMs: 3000,
    maxOutputBytes: 4096,
    auditLogFile,
    auditMaxBytes: 1024 * 1024,
    sessionTtlMs: 60_000
  };
}

function testConfigWithOrigins(auditLogFile: string, allowedOrigins: string[]): AppConfig {
  return {
    ...testConfig(auditLogFile),
    allowedOrigins
  };
}

function mcpHeaders(sessionId?: string): Record<string, string> {
  return {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': '2025-06-18',
    ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {})
  };
}

function request(id: number, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

function notification(method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', method, params });
}

function initializeBody(clientName: string): string {
  return request(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: clientName, version: '1.0.0' }
  });
}

function parseSseJsonRpc(text: string): any {
  const dataLine = text
    .split('\n')
    .find(line => line.startsWith('data: '));
  if (!dataLine) throw new Error(`missing SSE data line in: ${text}`);
  return JSON.parse(dataLine.slice('data: '.length));
}

function toolText(message: any): string {
  return message.result.content[0].text;
}

describe('HTTP MCP session routing', () => {
  it('creates independent transports per Mcp-Session-Id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-http-session-'));
    const { app } = await createApp(testConfig(join(dir, 'audit.jsonl')));

    const initA = await app.request('/mcp', {
      method: 'POST',
      headers: mcpHeaders(),
      body: initializeBody('client-a')
    });
    const sessionA = initA.headers.get('mcp-session-id');
    expect(initA.status).toBe(200);
    expect(sessionA).toBeTruthy();

    const initB = await app.request('/mcp', {
      method: 'POST',
      headers: mcpHeaders(),
      body: initializeBody('client-b')
    });
    const sessionB = initB.headers.get('mcp-session-id');
    expect(initB.status).toBe(200);
    expect(sessionB).toBeTruthy();
    expect(sessionB).not.toBe(sessionA);

    await app.request('/mcp', {
      method: 'POST',
      headers: mcpHeaders(sessionA!),
      body: notification('notifications/initialized')
    });
    await app.request('/mcp', {
      method: 'POST',
      headers: mcpHeaders(sessionB!),
      body: notification('notifications/initialized')
    });

    const callA = app.request('/mcp', {
      method: 'POST',
      headers: mcpHeaders(sessionA!),
      body: request(2, 'tools/call', {
        name: 'run_command',
        arguments: { command: 'sleep 0.1; echo A', timeoutMs: 3000, maxOutputBytes: 2048 }
      })
    });

    const callB = app.request('/mcp', {
      method: 'POST',
      headers: mcpHeaders(sessionB!),
      body: request(2, 'tools/call', {
        name: 'run_command',
        arguments: { command: 'sleep 0.3; echo B', timeoutMs: 3000, maxOutputBytes: 2048 }
      })
    });

    const [responseA, responseB] = await Promise.all([callA, callB]);
    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);

    const messageA = parseSseJsonRpc(await responseA.text());
    const messageB = parseSseJsonRpc(await responseB.text());
    expect(toolText(messageA)).toContain('"stdout": "A\\n"');
    expect(toolText(messageA)).not.toContain('"stdout": "B\\n"');
    expect(toolText(messageB)).toContain('"stdout": "B\\n"');
    expect(toolText(messageB)).not.toContain('"stdout": "A\\n"');
  });

  it('requires valid session headers after initialization', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-http-session-'));
    const { app } = await createApp(testConfig(join(dir, 'audit.jsonl')));

    const missing = await app.request('/mcp', {
      method: 'POST',
      headers: mcpHeaders(),
      body: request(2, 'tools/list')
    });
    expect(missing.status).toBe(400);

    const invalid = await app.request('/mcp', {
      method: 'POST',
      headers: mcpHeaders('not-a-session'),
      body: request(2, 'tools/list')
    });
    expect(invalid.status).toBe(404);
  });

  it('exposes tool output schemas, annotations, and auth metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-http-session-'));
    const { app } = await createApp(testConfig(join(dir, 'audit.jsonl')));

    const init = await app.request('/mcp', {
      method: 'POST',
      headers: mcpHeaders(),
      body: initializeBody('schema-client')
    });
    const session = init.headers.get('mcp-session-id');
    expect(session).toBeTruthy();

    await app.request('/mcp', {
      method: 'POST',
      headers: mcpHeaders(session!),
      body: notification('notifications/initialized')
    });

    const list = await app.request('/mcp', {
      method: 'POST',
      headers: mcpHeaders(session!),
      body: request(2, 'tools/list')
    });
    expect(list.status).toBe(200);

    const message = parseSseJsonRpc(await list.text());
    const tools = message.result.tools as any[];
    const runCommand = tools.find(tool => tool.name === 'run_command');
    const readFile = tools.find(tool => tool.name === 'read_file');

    expect(runCommand.outputSchema).toMatchObject({
      type: 'object',
      properties: {
        stdout: { type: 'string' },
        exitCode: {
          anyOf: expect.arrayContaining([
            expect.objectContaining({ type: 'integer' }),
            expect.objectContaining({ type: 'null' })
          ])
        }
      }
    });
    expect(runCommand.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true
    });
    expect(runCommand._meta.securitySchemes).toEqual([{ type: 'noauth' }]);
    expect(readFile.outputSchema).toMatchObject({
      type: 'object',
      properties: {
        text: { type: 'string' }
      }
    });
  });

  it('uses configured allowed origins for CORS responses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-http-session-'));
    const { app } = await createApp(
      testConfigWithOrigins(join(dir, 'audit.jsonl'), ['https://chatgpt.com'])
    );

    const allowed = await app.request('/mcp', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://chatgpt.com',
        'Access-Control-Request-Method': 'POST'
      }
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://chatgpt.com');

    const denied = await app.request('/mcp', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'POST'
      }
    });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });
});
