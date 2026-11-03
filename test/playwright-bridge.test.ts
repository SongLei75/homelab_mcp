import { describe, expect, it } from 'vitest';
import { PlaywrightBridge, browserTypes } from '../src/mcp/playwright.js';

describe('Playwright MCP bridge', () => {
  it('discovers native tools, rejects Chrome without its token, and reuses headless browser state', async () => {
    const bridge = new PlaywrightBridge();
    const originalToken = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    try {
      await bridge.discover();
      expect(bridge.tools.some(tool => tool.name === 'browser_navigate')).toBe(true);
      const preparedTools = bridge.tools;
      expect(bridge.tools).toBe(preparedTools);
      const navigate = preparedTools.find(tool => tool.name === 'browser_navigate');
      expect(navigate?.definition.inputSchema).toBeDefined();
      expect(browserTypes).toEqual(['chrome', 'chromium', 'msedge', 'firefox', 'webkit']);

      delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
      const missingToken = await bridge.callTool('browser_tabs', { action: 'list' }, 'chrome');
      expect(missingToken.isError).toBe(true);
      expect(JSON.stringify(missingToken.content)).toContain('PLAYWRIGHT_MCP_EXTENSION_TOKEN');

      const first = await bridge.callTool('browser_navigate', {
        url: 'data:text/html,<title>bridge-test</title><h1>persistent-page</h1>'
      }, 'chromium');
      expect(first.isError).not.toBe(true);
      const second = await bridge.callTool('browser_snapshot', {}, 'chromium');
      expect(JSON.stringify(second.content)).toContain('persistent-page');
    } finally {
      if (originalToken === undefined) delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
      else process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = originalToken;
      await bridge.close();
    }
  }, 20_000);
});
