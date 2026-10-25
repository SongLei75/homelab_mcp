import { createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';

const WHSEC_PREFIX = 'whsec_';

export function decodeWebhookSecret(secret: string): Buffer {
  if (!secret || !secret.startsWith(WHSEC_PREFIX)) {
    throw new Error("Webhook secret must start with 'whsec_'.");
  }
  const rawPart = secret.slice(WHSEC_PREFIX.length);
  if (rawPart.length < 16 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(rawPart)) {
    throw new Error("Webhook secret after 'whsec_' must be valid base64 (at least 16 chars).");
  }
  const normalizedBase64 = rawPart.replace(/-/g, '+').replace(/_/g, '/');
  const keyBuffer = Buffer.from(normalizedBase64, 'base64');
  if (keyBuffer.byteLength < 24 || keyBuffer.byteLength > 64) {
    throw new Error('Webhook secret must decode to 24-64 bytes.');
  }
  return keyBuffer;
}

export function signStandardWebhook(
  webhookId: string,
  timestampSeconds: number,
  rawBody: string,
  secret: string
): string {
  const key = decodeWebhookSecret(secret);
  const toSign = `${webhookId}.${timestampSeconds}.${rawBody}`;
  const signature = createHmac('sha256', key)
    .update(toSign, 'utf8')
    .digest('base64');
  return `v1,${signature}`;
}

function isPrivateOrReservedIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true;
    return false;
  }

  if (version === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === '::' || normalized === '::1') return true;
    if (/^fe[89ab]/.test(normalized)) return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (normalized.startsWith('ff')) return true;
    // Deny mapped IPv4 addresses rather than potentially missing a hex-encoded private address.
    if (normalized.startsWith('::ffff:')) return true;
    if (normalized.startsWith('2001:db8:')) return true;
    if (!normalized.startsWith('2') && !normalized.startsWith('3')) return true;
    return false;
  }

  return true;
}

export async function assertSafeWebhookUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid delivery URL.');
  }

  const allowLoopbackForTest =
    process.env.PRIVATE_MCP_TEST_ALLOW_LOOPBACK === '1' &&
    (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');

  if (!allowLoopbackForTest && parsed.protocol !== 'https:') {
    throw new Error('Webhook delivery URL must use HTTPS.');
  }

  if (parsed.username || parsed.password) {
    throw new Error('Webhook delivery URL must not contain credentials.');
  }

  if (allowLoopbackForTest) {
    return parsed;
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === 'metadata.google.internal'
  ) {
    throw new Error('Forbidden webhook hostname.');
  }

  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new Error('Webhook URL resolves to a private or reserved IP address.');
    }
    return parsed;
  }

  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!records || records.length === 0) {
    throw new Error('Unable to resolve webhook hostname.');
  }

  for (const record of records) {
    if (isPrivateOrReservedIp(record.address)) {
      throw new Error('Webhook hostname resolves to a forbidden private or reserved IP.');
    }
  }

  return parsed;
}

/** Post over a freshly validated, IP-pinned socket. No redirect or implicit second DNS lookup. */
export async function postWebhook(
  rawUrl: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number
): Promise<{ status: number; ok: boolean; body: string; contentType: string }> {
  const url = await assertSafeWebhookUrl(rawUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const isTestLoopback = process.env.PRIVATE_MCP_TEST_ALLOW_LOOPBACK === '1' &&
    (hostname === '127.0.0.1' || hostname === 'localhost');
  if (!isTestLoopback && url.port && url.port !== '443') {
    throw new Error('Only HTTPS port 443 is allowed for webhook destinations.');
  }
  const resolved = isTestLoopback ? [{ address: '127.0.0.1', family: 4 }] :
    net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] :
    await dns.lookup(hostname, { all: true, verbatim: true });
  if (!resolved.length || resolved.some(ip => !isTestLoopback && isPrivateOrReservedIp(ip.address))) {
    throw new Error('Forbidden webhook destination address');
  }
  // The socket connects to the vetted IP. SNI/certificate verification use the original domain.
  const address = resolved[0].address;
  const requestImpl = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return await new Promise((resolve, reject) => {
    const request = requestImpl({
      hostname: address,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      servername: url.protocol === 'https:' ? hostname : undefined,
      agent: false,
      headers: { ...headers, Host: url.host, 'Content-Length': Buffer.byteLength(body) }
    }, response => {
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > 8192) {
          request.destroy(new Error('Webhook response too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const status = response.statusCode ?? 0;
        resolve({ status, ok: status >= 200 && status < 300,
          body: Buffer.concat(chunks).toString('utf8'),
          contentType: String(response.headers['content-type'] ?? '') });
      });
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Webhook timeout')));
    request.on('error', reject);
    request.end(body);
  });
}
