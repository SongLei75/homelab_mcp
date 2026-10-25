import 'dotenv/config';

import { serve } from '@hono/node-server';

import { loadConfig, resolveCollabConfig } from './config.js';
import { createApp } from './http/app.js';

const config = loadConfig();
const collabConfig = resolveCollabConfig(config);
const { app, close } = await createApp(config);

console.log(`private-mcp listening on http://${config.host}:${config.port}`);
console.log(`health: http://${config.host}:${config.port}/healthz`);
console.log(`mcp:    http://${config.host}:${config.port}/mcp`);
console.log(`auth:   ${config.authMode}`);
console.log(`db:     ${collabConfig.dbPath}`);

const server = serve({
  fetch: app.fetch,
  hostname: config.host,
  port: config.port
});

function shutdown() {
  close();
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
