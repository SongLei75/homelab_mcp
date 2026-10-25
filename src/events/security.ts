import { createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import type { CollabConfig } from '../config.js';

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

type SsrfPolicy = Pick<CollabConfig,
  'webhookSsrfEnabled' | 'webhookSsrfAllowedHostnames' | 'webhookSsrfAllowedIpRanges'>;

function matchesHostname(hostname: string, names: string[]): boolean {
  return names.some(pattern => {
    const p = pattern.toLowerCase();
    return p.startsWith('*.') ? hostname.endsWith(p.slice(1)) && hostname !== p.slice(2) : hostname === p;
  });
}

function isAllowedException(hostname: string, ip: string, policy?: SsrfPolicy): boolean {
  if (!policy?.webhookSsrfAllowedHostnames?.length || !policy.webhookSsrfAllowedIpRanges?.length || !matchesHostname(hostname, policy.webhookSsrfAllowedHostnames)) {
    return false;
  }
  const family = net.isIP(ip);
  if (!family) return false;
  const block = new net.BlockList();
  for (const entry of policy.webhookSsrfAllowedIpRanges) {
    const [base, prefix] = entry.split('/');
    const version = net.isIP(base);
    if (!version || !/^(0|[1-9]\d*)$/.test(prefix ?? '') || Number(prefix) > (version === 4 ? 32 : 128)) {
      throw new Error('Invalid webhook SSRF allowed CIDR.');
    }
    block.addSubnet(base, Number(prefix), version === 4 ? 'ipv4' : 'ipv6');
  }
  return block.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

function isForbiddenMetadata(hostname: string, ip?: string): boolean {
  if (hostname === 'metadata.google.internal' || hostname === 'metadata.azure.internal') return true;
  if (!ip) return false;
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (a === 169 && b === 254) || ip === '100.100.100.200';
  }
  return net.isIP(ip) === 6 && /^fe[89ab]/i.test(ip);
}

function checkDestination(hostname: string, ip: string, policy?: SsrfPolicy): void {
  // Cloud metadata and link-local endpoints remain blocked even with an exception.
  if (isForbiddenMetadata(hostname, ip)) throw new Error('Forbidden metadata or link-local webhook destination.');
  if (policy?.webhookSsrfEnabled === false) return;
  if (isPrivateOrReservedIp(ip) && !isAllowedException(hostname, ip, policy)) {
    throw new Error('Webhook hostname resolves to a forbidden private or reserved IP.');
  }
}

export async function assertSafeWebhookUrl(rawUrl: string, policy?: SsrfPolicy): Promise<URL> {
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
  if (allowLoopbackForTest) return parsed;

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isForbiddenMetadata(hostname)) throw new Error('Forbidden metadata webhook hostname.');
  if (policy?.webhookSsrfEnabled !== false) {
    const localName = hostname === 'localhost' || hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') || hostname.endsWith('.internal');
    if (localName && !matchesHostname(hostname, policy?.webhookSsrfAllowedHostnames ?? [])) {
      throw new Error('Forbidden webhook hostname.');
    }
  }
  const records = net.isIP(hostname)
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!records.length) throw new Error('Unable to resolve webhook hostname.');
  for (const record of records) checkDestination(hostname, record.address, policy);
  return parsed;
}

/** Post over a freshly validated, IP-pinned socket. No redirect or implicit second DNS lookup. */
export async function postWebhook(
  rawUrl: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  policy?: SsrfPolicy
): Promise<{ status: number; ok: boolean; body: string; contentType: string }> {
  const url = await assertSafeWebhookUrl(rawUrl, policy);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const isTestLoopback = process.env.PRIVATE_MCP_TEST_ALLOW_LOOPBACK === '1' &&
    (hostname === '127.0.0.1' || hostname === 'localhost');
  if (!isTestLoopback && url.port && url.port !== '443') {
    throw new Error('Only HTTPS port 443 is allowed for webhook destinations.');
  }
  const resolved = isTestLoopback ? [{ address: '127.0.0.1', family: 4 }] :
    net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] :
    await dns.lookup(hostname, { all: true, verbatim: true });
  if (!resolved.length) throw new Error('Unable to resolve webhook destination.');
  if (!isTestLoopback) for (const record of resolved) checkDestination(hostname.toLowerCase(), record.address, policy);
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
