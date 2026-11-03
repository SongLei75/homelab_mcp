import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { fromJsonSchema, type CallToolResult } from '@modelcontextprotocol/server';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const browserTypes = ['chrome', 'chromium', 'msedge', 'firefox', 'webkit'] as const;
export type BrowserType = typeof browserTypes[number];
type NativeTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];

type PlaywrightTool = {
  name: string;
  definition: {
    title: NativeTool['title'];
    description: string;
    inputSchema: ReturnType<typeof fromJsonSchema>;
    outputSchema?: ReturnType<typeof fromJsonSchema>;
    annotations: NativeTool['annotations'];
    _meta: NativeTool['_meta'];
  };
};

const CLI = fileURLToPath(new URL('../../node_modules/.bin/playwright-mcp', import.meta.url));

function startClient(browserType: BrowserType): Promise<Client> {
  if (browserType === 'chrome' && !process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN?.trim()) {
    throw new Error('PLAYWRIGHT_MCP_EXTENSION_TOKEN is missing from the private MCP process environment; Chrome extension mode is unavailable.');
  }
  const client = new Client({ name: 'homelab-playwright-proxy', version: '0.1.0' });
  const env = getDefaultEnvironment();
  if (browserType === 'chrome') {
    env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN!;
    if (process.env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME) {
      env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME = process.env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME;
    }
  }
  const args = browserType === 'chrome'
    ? ['--extension']
    : ['--headless', '--isolated', `--browser=${browserType === 'chromium' ? 'chrome' : browserType}`];
  args.push('--output-dir', join(tmpdir(), 'homelab-playwright', String(process.pid), browserType));
  const transport = new StdioClientTransport({ command: CLI, args, env });
  return client.connect(transport).then(
    () => client,
    async error => {
      await client.close().catch(() => {});
      throw error;
    }
  );
}

/**
 * Discover tool definitions once. The browser and connection itself are only
 * created by Playwright on the first tool call for each mode.
 */
export class PlaywrightBridge {
  private readonly clients = new Map<BrowserType, Promise<Client>>();
  private readonly nativeTools = new Map<string, NativeTool>();
  private preparedTools: readonly PlaywrightTool[] = [];
  private closed = false;

  get tools(): readonly PlaywrightTool[] {
    return this.preparedTools;
  }

  async discover(): Promise<void> {
    const discovery = await startClient('chromium');
    try {
      const { tools } = await discovery.listTools();
      // Convert schemas once during discovery, not for every HTTP request.
      const prepared = tools.map(native => {
        const inputSchema = {
          ...native.inputSchema,
          properties: {
            ...native.inputSchema.properties,
            browserType: {
              type: 'string',
              enum: [...browserTypes],
              description: 'chrome (default): existing Google Chrome via Playwright Extension, requires PLAYWRIGHT_MCP_EXTENSION_TOKEN. chromium: independent headless Chrome. msedge, firefox, webkit: independent headless browsers. Keep browserType consistent across calls.',
              default: 'chrome'
            }
          }
        };
        return {
          name: native.name,
          definition: {
            title: native.title,
            description: `${native.description ?? ''} Use browserType=chrome for the user's existing Chrome session, or browserType=chromium/msedge/firefox/webkit for independent headless testing.`,
            inputSchema: fromJsonSchema(inputSchema),
            ...(native.outputSchema ? { outputSchema: fromJsonSchema(native.outputSchema) } : {}),
            annotations: native.annotations,
            _meta: native._meta
          }
        };
      });
      this.nativeTools.clear();
      for (const tool of tools) this.nativeTools.set(tool.name, tool);
      this.preparedTools = prepared;
    } finally {
      await discovery.close();
    }
  }

  private getClient(browserType: BrowserType): Promise<Client> {
    if (this.closed) throw new Error('Playwright bridge is closed');
    const current = this.clients.get(browserType);
    if (current) return current;
    const pending = startClient(browserType);
    this.clients.set(browserType, pending);
    void pending.catch(() => {
      if (this.clients.get(browserType) === pending) this.clients.delete(browserType);
    });
    return pending;
  }

  async callTool(name: string, args: Record<string, unknown>, browserType: BrowserType): Promise<CallToolResult> {
    if (!this.nativeTools.has(name)) {
      return { isError: true, content: [{ type: 'text', text: `Unknown Playwright tool: ${name}` }] };
    }
    if (browserType === 'chrome' && !process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN?.trim()) {
      return { isError: true, content: [{ type: 'text', text: 'PLAYWRIGHT_MCP_EXTENSION_TOKEN is missing from the private MCP process environment; Chrome extension mode is unavailable.' }] };
    }
    let pending: Promise<Client> | undefined;
    try {
      pending = this.getClient(browserType);
      const client = await pending;
      return await client.callTool({ name, arguments: args }) as CallToolResult;
    } catch (error) {
      if (pending && this.clients.get(browserType) === pending) {
        this.clients.delete(browserType);
        const client = await pending.catch(() => undefined);
        if (client) await client.close().catch(() => {});
      }
      return {
        isError: true,
        content: [{ type: 'text', text: `Playwright ${browserType} failed: ${error instanceof Error ? error.message : String(error)}` }]
      };
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map(async pending => {
      const client = await pending.catch(() => undefined);
      if (client) await client.close().catch(() => {});
    }));
  }
}
