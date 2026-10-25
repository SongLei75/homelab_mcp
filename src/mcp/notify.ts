import { createHash } from 'node:crypto';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { dirname, join } from 'node:path';

// User-private Unix socket, scoped to the SQLite database. Only resource change
// hints cross the wire: message contents and credentials stay in SQLite/MCP.
function socketPath(dbPath: string): string {
  const hash = createHash('sha256').update(dbPath).digest('hex').slice(0, 12);
  return join(dirname(dbPath), `mcp-notify-${hash}.sock`);
}

function isResourceUri(value: string): boolean {
  return /^collab:\/\/channels\/[a-zA-Z0-9._-]{1,64}\/messages$/.test(value);
}

export interface NotificationBridge {
  publish(uri: string): void;
  close(): void;
}

export async function createNotificationHub(dbPath: string, onChange: (uri: string) => void): Promise<NotificationBridge> {
  const path = socketPath(dbPath);
  const clients = new Set<Socket>();
  const server = createServer(socket => {
    clients.add(socket);
    socket.setEncoding('utf8');
    let pending = '';
    socket.on('data', (chunk: string) => {
      pending += chunk;
      if (pending.length > 2048) return socket.destroy();
      let split: number;
      while ((split = pending.indexOf('\n')) !== -1) {
        const uri = pending.slice(0, split);
        pending = pending.slice(split + 1);
        if (!isResourceUri(uri)) continue;
        onChange(uri);
        for (const peer of clients) if (peer !== socket && peer.writable) peer.write(uri + '\n');
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => { clients.delete(socket); });
  });

  // Remove only a stale socket: never unlink a live publisher's endpoint.
  if (existsSync(path)) {
    const live = await new Promise<boolean>(resolve => {
      const probe = createConnection(path);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', () => { resolve(false); });
    });
    if (live) throw new Error(`Notification hub is already running: ${path}`);
    unlinkSync(path);
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => { server.off('error', reject); resolve(); });
    });
    chmodSync(path, 0o600);
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    publish(uri) { if (isResourceUri(uri)) for (const peer of clients) if (peer.writable) peer.write(uri + '\n'); },
    close() {
      for (const peer of clients) peer.destroy();
      server.close();
      if (existsSync(path)) unlinkSync(path);
    }
  };
}

export function createNotificationClient(dbPath: string, onChange: (uri: string) => void): NotificationBridge {
  const path = socketPath(dbPath);
  let socket: Socket | undefined;
  let reconnect: NodeJS.Timeout | undefined;
  let stopped = false;

  function start() {
    if (stopped) return;
    const candidate = createConnection(path);
    socket = candidate;
    // The bridge must not hold the stdio process open after stdin closes.
    candidate.unref();
    candidate.setEncoding('utf8');
    let pending = '';
    candidate.on('data', (chunk: string) => {
      pending += chunk;
      if (pending.length > 2048) return candidate.destroy();
      let split: number;
      while ((split = pending.indexOf('\n')) !== -1) {
        const uri = pending.slice(0, split);
        pending = pending.slice(split + 1);
        if (isResourceUri(uri)) onChange(uri);
      }
    });
    candidate.on('error', () => {});
    candidate.on('close', () => {
      if (socket === candidate) socket = undefined;
      if (!stopped) { reconnect = setTimeout(start, 1000); reconnect.unref(); }
    });
  }
  start();
  return {
    publish(uri) { if (isResourceUri(uri) && socket?.writable) socket.write(uri + '\n'); },
    close() { stopped = true; if (reconnect) clearTimeout(reconnect); socket?.destroy(); }
  };
}
