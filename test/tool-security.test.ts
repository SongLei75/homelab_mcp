import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import { AuditLogger } from '../src/audit/audit.js';
import type { AppConfig } from '../src/config.js';
import { createMcpServer } from '../src/mcp/server.js';
import { toolSecuritySchemes } from '../src/tools/schema.js';

describe('per-tool security metadata', () => {
  it('advertises anonymous tools only on auth-off transport', () => {
    expect(toolSecuritySchemes('off', 'mcp:write')).toEqual([{ type: 'noauth' }]);
  });

  it.each(['mcp:read', 'mcp:write', 'mcp:command'])('requires OAuth scope %s on HTTP transport', scope => {
    expect(toolSecuritySchemes('oauth_jwt', scope)).toEqual([{ type: 'oauth2', scopes: [scope] }]);
  });

  it('does not misrepresent non-OAuth authentication as noauth', () => {
    expect(toolSecuritySchemes('static_bearer', 'mcp:read')).toBeUndefined();
    expect(toolSecuritySchemes('oauth_placeholder', 'mcp:read')).toBeUndefined();
  });

  it.each([
    { grantedScopes: ['mcp:read', 'mcp:write', 'mcp:command'], expectedTools: 7 },
    { grantedScopes: ['mcp:read'], expectedTools: 3 }
  ])('serializes the actual OAuth tool scopes with $expectedTools allowed tools', async ({ grantedScopes, expectedTools }) => {
    const config: AppConfig = {
      host: '127.0.0.1',
      port: 8787,
      authMode: 'oauth_jwt',
      allowedOrigins: [],
      auditToStdout: false,
      timeoutMs: 3000,
      maxOutputBytes: 4096,
      auditLogFile: join(tmpdir(), 'mcp-tool-security-test-audit.jsonl'),
      auditMaxBytes: 1024 * 1024
    };
    const server = createMcpServer(new AuditLogger(config), config, {
      subject: 'test',
      issuer: 'https://issuer.example/',
      audience: 'https://mcp.example/mcp',
      scopes: grantedScopes,
      claims: {}
    });
    const [client, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.start();

    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'scope-test', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {}
    };
    async function rpc(id: number, method: string, params: Record<string, unknown> = {}): Promise<any> {
      const answer = new Promise<any>(resolve => {
        client.onmessage = message => {
          if ('id' in message && message.id === id) resolve(message);
        };
      });
      await client.send({ jsonrpc: '2.0', id, method, params: { _meta: meta, ...params } });
      return answer;
    }

    try {
      const initialized = await rpc(1, 'initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'scope-test', version: '1' }
      });
      expect(initialized.result?.protocolVersion, JSON.stringify(initialized)).toBe('2025-11-25');
      const listed = (await rpc(2, 'tools/list')).result.tools as any[];
      expect(listed).toHaveLength(expectedTools);
      const scopeByTool: Record<string, string> = {
        read_file: 'mcp:read',
        read_logs: 'mcp:read',
        run_command: 'mcp:command',
        write_file: 'mcp:write',
        apply_patch: 'mcp:write',
        send_file: 'mcp:write',
        recv_file: 'mcp:read'
      };
      const sendFile = listed.find(tool => tool.name === 'send_file');
      if (sendFile) {
        expect(sendFile._meta['openai/fileParams']).toEqual(['file']);
        expect(sendFile.inputSchema.properties.file).toMatchObject({
          type: 'object',
          required: expect.arrayContaining(['download_url', 'file_id'])
        });
        expect(Object.keys(sendFile.inputSchema.properties.file.properties)).toEqual(
          expect.arrayContaining(['download_url', 'file_id', 'mime_type', 'file_name'])
        );
      }
      for (const tool of listed) {
        expect(tool._meta.securitySchemes).toEqual([
          { type: 'oauth2', scopes: [scopeByTool[tool.name]] }
        ]);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
