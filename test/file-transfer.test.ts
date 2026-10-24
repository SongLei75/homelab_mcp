import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRecvFileTool } from '../src/tools/recv-file.js';
import { createSendFileTool } from '../src/tools/send-file.js';

const audit = { write: async () => undefined } as any;
const file = {
  download_url: 'https://files.oaiusercontent.com/test-payload',
  file_id: 'file_test_123',
  file_name: 'payload.bin',
  mime_type: 'application/octet-stream'
};

afterEach(() => vi.restoreAllMocks());

describe('send_file OpenAI file parameters', () => {
  it('streams a file into a new destination, checks SHA-256, and uses restricted permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-send-file-'));
    const destination = join(dir, 'nested', 'payload.bin');
    const bytes = Buffer.from([0, 1, 255, 100, 0, 42]);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      new Uint8Array(bytes) as BodyInit,
      { status: 200, headers: { 'content-length': String(bytes.length) } }
    ));

    const result = await createSendFileTool(audit).handler({
      file, destination, createParentDirs: true, expectedSha256: sha256
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0].toString()).toBe(file.download_url);
    expect(await readFile(destination)).toEqual(bytes);
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    expect(result.structuredContent).toMatchObject({
      path: destination, fileId: file.file_id, fileName: 'payload.bin',
      bytes: bytes.length, sha256
    });
  });

  it('refuses to replace files by default and removes temporary downloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-send-file-no-clobber-'));
    const destination = join(dir, 'existing.txt');
    await writeFile(destination, 'original');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('replacement'));

    await expect(createSendFileTool(audit).handler({ file, destination })).rejects.toThrow();
    expect(await readFile(destination, 'utf8')).toBe('original');
    expect(await readdir(dir)).toEqual(['existing.txt']);
  });

  it('does not fetch arbitrary URLs, even through redirects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-send-file-ssrf-'));
    const destination = join(dir, 'blocked.txt');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, {
      status: 302, headers: { location: 'https://example.org/internal-file' }
    }));

    await expect(createSendFileTool(audit).handler({
      file: { ...file, download_url: 'http://127.0.0.1/private' }, destination
    })).rejects.toThrow('approved OpenAI HTTPS host');
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(createSendFileTool(audit).handler({ file, destination }))
      .rejects.toThrow('approved OpenAI HTTPS host');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await readdir(dir)).toEqual([]);
  });

  it('enforces declared size and checksum without creating a destination', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-send-file-checks-'));
    const destination = join(dir, 'blocked.bin');
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response('x', {
      headers: { 'content-length': String(50 * 1024 * 1024 + 1) }
    }));
    await expect(createSendFileTool(audit).handler({ file, destination }))
      .rejects.toThrow('50 MiB transfer limit');

    fetchMock.mockResolvedValueOnce(new Response('checksum mismatch'));
    await expect(createSendFileTool(audit).handler({
      file, destination, expectedSha256: '0'.repeat(64)
    })).rejects.toThrow('SHA-256 verification failed');
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('recv_file binary MCP resource', () => {
  it('preserves file bytes, MIME type, size and SHA-256', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-recv-file-'));
    const path = join(dir, 'sample.png');
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
    await writeFile(path, bytes);

    const result = await createRecvFileTool(audit).handler({ path });
    expect(result.structuredContent).toMatchObject({
      path, fileName: 'sample.png', mimeType: 'image/png', bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex')
    });
    const embedded = result.content?.find(item => item.type === 'resource');
    expect(embedded?.type).toBe('resource');
    if (embedded?.type !== 'resource') throw new Error('No embedded resource');
    expect(embedded.resource.mimeType).toBe('image/png');
    if (!('blob' in embedded.resource)) throw new Error('Expected a binary resource');
    expect(Buffer.from(embedded.resource.blob, 'base64')).toEqual(bytes);
  });

  it('rejects files larger than the explicit inline limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-recv-file-large-'));
    const path = join(dir, 'large.bin');
    await writeFile(path, Buffer.alloc(2 * 1024 * 1024 + 1));
    await expect(createRecvFileTool(audit).handler({ path }))
      .rejects.toThrow('2 MiB inline transfer limit');
  });
});
