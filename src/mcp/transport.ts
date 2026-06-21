import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

export function createMcpTransport(): WebStandardStreamableHTTPServerTransport {
  // Stateless transport: enough for the P0 date-tool validation path.
  return new WebStandardStreamableHTTPServerTransport();
}
