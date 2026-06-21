# mcp-local-gateway

P0 goal: run a minimal local MCP server that exposes exactly one tool, `run_date`, through a Streamable HTTP `/mcp` endpoint.

This project is intentionally small. It does not expose arbitrary Bash. It does not use an OpenAI API key. It is designed for this validation chain:

```text
ChatGPT Web
  -> HTTPS /mcp
  -> Cloudflare Tunnel or another HTTPS tunnel
  -> 127.0.0.1:8787
  -> Hono
  -> MCP Server
  -> policy layer
  -> fixed date command
```

## Terms

- MCP: Model Context Protocol, 模型上下文协议，用来让 AI Host 通过标准协议发现并调用外部工具。
- Streamable HTTP: 可流式 HTTP 传输，适合远程 MCP server。
- Hono: 轻量 HTTP framework，HTTP 框架。
- OAuth: Open Authorization，开放授权。P0 只预留结构，不实现完整授权码流程。
- Policy layer: 策略层，本项目中用于拒绝任意命令，只允许 `run_date -> date`。

## Requirements

- Node.js >= 20.11
- npm
- Linux / WSL recommended

## Install

```bash
cd ~/project/mcp-local-gateway
npm install
cp .env.example .env
```

## Start

```bash
npm run dev
```

Expected startup lines:

```text
mcp-local-gateway listening on http://127.0.0.1:8787
health: http://127.0.0.1:8787/healthz
mcp:    http://127.0.0.1:8787/mcp
auth:   off
```

## Local validation

In another terminal:

```bash
cd ~/project/mcp-local-gateway
npm run typecheck
npm run build
npm test
npm run test:local
```

The `tools/list` response should include `run_date`. The `tools/call` response should include JSON text containing `stdout` from the local `date` command.

## Static bearer mode

Use this before exposing through a tunnel if you are not using OAuth yet.

```bash
cat > .env <<'ENDENV'
HOST=127.0.0.1
PORT=8787
MCP_AUTH_MODE=static_bearer
MCP_STATIC_BEARER_TOKEN=replace-this-with-a-long-random-token
MCP_ALLOWED_ORIGINS=http://127.0.0.1:8787,http://localhost:8787,https://chatgpt.com
AUDIT_TO_STDOUT=true
AUDIT_LOG_FILE=logs/audit.jsonl
ENDENV

npm run dev
```

Validation with token:

```bash
MCP_STATIC_BEARER_TOKEN='replace-this-with-a-long-random-token' npm run test:local
```

## Cloudflare Tunnel sketch

Do not bind this server to `0.0.0.0`. Keep `HOST=127.0.0.1` and publish it with a tunnel.

Example target mapping:

```text
https://mcp.songlei.me/mcp -> http://127.0.0.1:8787/mcp
```

After that, create a ChatGPT connector and set Connector URL to:

```text
https://mcp.songlei.me/mcp
```

P0 recommendation: use static bearer only for a private short-lived test. P1 should implement OAuth / OIDC token validation or put the MCP server behind a compatible identity-aware proxy.

## Security constraints in P0

- No arbitrary Bash.
- `run_date` accepts no arguments.
- Command execution uses `spawn` with `shell: false`.
- Server refuses `HOST=0.0.0.0`.
- `/mcp` checks Origin when Origin is present.
- `/mcp` can enforce static Bearer token.
- Each tool call writes JSONL audit records.

## File map

```text
src/index.ts              entry point
src/config.ts             environment config and startup safety checks
src/http/app.ts           Hono app, health endpoint, /mcp route
src/http/origin.ts        Origin allowlist guard
src/auth/auth.ts          off/static_bearer/oauth_placeholder auth middleware
src/mcp/server.ts         MCP server creation and tool registration
src/mcp/transport.ts      Streamable HTTP transport creation
src/tools/run-date.ts     run_date MCP tool
src/policy/policy.ts      P0 allow/deny logic
src/shell/exec-fixed.ts   fixed date command execution
src/audit/audit.ts        JSONL audit logger
scripts/local-validate.sh curl-based validation script
test/*.test.ts            minimal unit tests
```
