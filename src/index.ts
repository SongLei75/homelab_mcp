import 'dotenv/config';

import { serve } from '@hono/node-server';

import { loadConfig } from './config.js';
import { createApp } from './http/app.js';

const config = loadConfig();
const { app } = await createApp(config);

console.log(`mcp-local-gateway listening on http://${config.host}:${config.port}`);
console.log(`health: http://${config.host}:${config.port}/healthz`);
console.log(`mcp:    http://${config.host}:${config.port}/mcp`);
console.log(`auth:   ${config.authMode}`);

serve({
  fetch: app.fetch,
  hostname: config.host,
  port: config.port
});
