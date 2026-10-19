import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

export interface McpRequestContext {
  requestId: string;
  mcpSessionId?: string;
  openaiSessionHash?: string;
  openaiSubjectHash?: string;
  rpcIds: string[];
  rpcMethods: string[];
  bodyHash?: string;
  bodyBytes?: number;
  cfRay?: string;
  traceparent?: string;
  userAgent?: string;
}

export interface JsonRpcRequestSummary {
  rpcIds: string[];
  rpcMethods: string[];
  bodyHash?: string;
  bodyBytes?: number;
}

const requestContext = new AsyncLocalStorage<McpRequestContext>();

export function hashDebugValue(value: string | null): string | undefined {
  if (!value) return undefined;
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export async function summarizeJsonRpcRequest(req: Request): Promise<JsonRpcRequestSummary> {
  if (req.method !== 'POST') {
    return { rpcIds: [], rpcMethods: [] };
  }

  const body = await req.clone().text();
  const summary: JsonRpcRequestSummary = {
    rpcIds: [],
    rpcMethods: [],
    bodyHash: createHash('sha256').update(body).digest('hex').slice(0, 16),
    bodyBytes: Buffer.byteLength(body, 'utf8')
  };

  try {
    const parsed = JSON.parse(body);
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue;
      if ('id' in message) {
        const id = (message as { id?: unknown }).id;
        summary.rpcIds.push(`${typeof id}:${String(id)}`);
      }
      const method = (message as { method?: unknown }).method;
      if (typeof method === 'string') summary.rpcMethods.push(method);
    }
  } catch {
    // The transport will report malformed JSON. Debug logging must not change behavior.
  }

  return summary;
}

export function runWithMcpRequestContext<T>(
  context: McpRequestContext,
  callback: () => T
): T {
  return requestContext.run(context, callback);
}

export function getMcpRequestContext(): McpRequestContext | undefined {
  return requestContext.getStore();
}
