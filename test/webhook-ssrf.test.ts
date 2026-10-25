import dns from 'node:dns/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resolveCollabConfig } from '../src/config.js';
import { assertSafeWebhookUrl, postWebhook } from '../src/events/security.js';

afterEach(() => vi.restoreAllMocks());

function policy(hosts = 'connectors.api.openai.com', ranges = '198.18.0.0/15') {
  return resolveCollabConfig(loadConfig({
    WEBHOOK_SSRF_ALLOWED_HOSTNAMES: hosts,
    WEBHOOK_SSRF_ALLOWED_IP_RANGES: ranges
  }));
}

function fakeDns(address: string) {
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address, family: 4 }] as never);
}

describe('configurable SSRF protections', () => {
  it('defaults to blocking the OpenClash Fake-IP range', async () => {
    fakeDns('198.18.49.157');
    await expect(assertSafeWebhookUrl('https://connectors.api.openai.com/hooks'))
      .rejects.toThrow(/forbidden private or reserved IP/i);
  });

  it('accepts a restricted IP only when hostname and CIDR both match', async () => {
    fakeDns('198.18.49.157');
    await expect(assertSafeWebhookUrl('https://connectors.api.openai.com/hooks', policy()))
      .resolves.toBeInstanceOf(URL);
    await expect(assertSafeWebhookUrl('https://untrusted.example.com/hooks', policy()))
      .rejects.toThrow(/forbidden private or reserved IP/i);
    await expect(assertSafeWebhookUrl('https://connectors.api.openai.com/hooks', policy('connectors.api.openai.com', '198.19.0.0/16')))
      .rejects.toThrow(/forbidden private or reserved IP/i);
  });

  it('matches wildcard hostnames at domain boundaries only', async () => {
    fakeDns('198.18.49.157');
    const allowed = policy('*.api.openai.com', '198.18.0.0/15');
    await expect(assertSafeWebhookUrl('https://connectors.api.openai.com/hooks', allowed)).resolves.toBeInstanceOf(URL);
    await expect(assertSafeWebhookUrl('https://evilapi.openai.com/hooks', allowed)).rejects.toThrow();
    await expect(assertSafeWebhookUrl('https://api.openai.com/hooks', allowed)).rejects.toThrow();
  });

  it('allows explicitly configured intranet pairs but always blocks metadata/link-local', async () => {
    fakeDns('192.168.2.1');
    await expect(assertSafeWebhookUrl('https://router.local/hooks', policy('router.local', '192.168.0.0/16')))
      .resolves.toBeInstanceOf(URL);
    await expect(assertSafeWebhookUrl('https://router.local/hooks'))
      .rejects.toThrow();
    const disabled = resolveCollabConfig(loadConfig({ WEBHOOK_SSRF_ENABLED: 'false' }));
    await expect(assertSafeWebhookUrl('https://192.168.2.1/hooks', disabled)).resolves.toBeInstanceOf(URL);
    await expect(assertSafeWebhookUrl('https://169.254.169.254/hooks', disabled)).rejects.toThrow(/metadata|link-local/i);
    await expect(assertSafeWebhookUrl('https://metadata.google.internal/hooks', disabled)).rejects.toThrow(/metadata/i);
    await expect(assertSafeWebhookUrl('https://169.254.169.254/hooks', policy('169.254.169.254', '169.254.0.0/16'))).rejects.toThrow();
  });

  it('keeps HTTPS requirements and credentials restrictions when SSRF is disabled', async () => {
    const disabled = resolveCollabConfig(loadConfig({ WEBHOOK_SSRF_ENABLED: 'false' }));
    await expect(assertSafeWebhookUrl('http://127.0.0.1/hook', disabled)).rejects.toThrow(/HTTPS/);
    await expect(assertSafeWebhookUrl('https://admin:pass@127.0.0.1/hook', disabled)).rejects.toThrow(/credentials/);
  });

  it('rejects invalid or incomplete exception configurations', () => {
    expect(() => loadConfig({ WEBHOOK_SSRF_ALLOWED_HOSTNAMES: 'connectors.api.openai.com' })).toThrow(/both be set/);
    expect(() => loadConfig({ WEBHOOK_SSRF_ALLOWED_IP_RANGES: '198.18.0.0\/15' })).toThrow(/both be set/);
    expect(() => loadConfig({ WEBHOOK_SSRF_ALLOWED_HOSTNAMES: '*', WEBHOOK_SSRF_ALLOWED_IP_RANGES: '198.18.0.0/15' })).toThrow(/Invalid/);
    expect(() => loadConfig({ WEBHOOK_SSRF_ALLOWED_HOSTNAMES: 'example.com', WEBHOOK_SSRF_ALLOWED_IP_RANGES: '198.18.0.0/99' })).toThrow(/Invalid/);
  });

  it('revalidates DNS before connecting, preventing rebinding outside the exception', async () => {
    const lookup = vi.spyOn(dns, 'lookup');
    lookup.mockResolvedValueOnce([{ address: '198.18.49.157', family: 4 }] as never);
    lookup.mockResolvedValueOnce([{ address: '192.168.2.1', family: 4 }] as never);
    await expect(postWebhook('https://connectors.api.openai.com/test', {}, '{}', 1000, policy()))
      .rejects.toThrow(/forbidden private or reserved IP/i);
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
