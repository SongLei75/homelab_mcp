import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

type StreamableHttpTransportOptions = ConstructorParameters<
  typeof WebStandardStreamableHTTPServerTransport
>[0];

export function createMcpTransport(
  options: StreamableHttpTransportOptions = {}
): WebStandardStreamableHTTPServerTransport {
  return new WebStandardStreamableHTTPServerTransport(options);
}
