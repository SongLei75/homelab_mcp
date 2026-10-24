# Configuration

The MCP server reads runtime configuration from environment variables. It does
not read Terraform state, Terraform outputs, Cloudflare config, or deployment
repository files. Deployment tooling is responsible for injecting the environment.

## Auth modes

`MCP_AUTH_MODE` supports:

- `off`: no authentication.
- `static_bearer`: require `MCP_STATIC_BEARER_TOKEN`.
- `oauth_jwt`: verify OAuth/OIDC JWT access tokens with issuer, audience, JWKS,
  and scopes.
- `oauth_placeholder`: legacy placeholder mode.

Auth0 is not a separate core auth mode. It is only a compatibility input for
`oauth_jwt`; generic OIDC style variables are preferred.

## OAuth/JWT variables

```env
MCP_AUTH_MODE=oauth_jwt
HOST=127.0.0.1
PORT=8787
MCP_PUBLIC_BASE_URL=https://mcp.example.com
MCP_RESOURCE_IDENTIFIER=https://mcp.example.com/mcp
OAUTH_ISSUER=https://issuer.example.com/
OAUTH_AUDIENCE=https://mcp.example.com/mcp
OAUTH_REQUIRED_SCOPES=mcp:read,mcp:command,mcp:write
```

`OAUTH_JWKS_URI` is optional. If omitted, the server derives it from
`OAUTH_ISSUER` as `.well-known/jwks.json`.

`offline_access` is advertised in protected-resource metadata so OAuth clients
can request refresh tokens when the upstream authorization server allows it. Do
not put `offline_access` in `OAUTH_REQUIRED_SCOPES`; it is not an MCP tool
permission and should not be required on every MCP request.

## systemd EnvironmentFile

`systemd` `EnvironmentFile=` is not a full shell `source`. Keep env files in
plain `KEY=VALUE` form. Do not use `export`, command substitution, nested
`source`, or shell expressions. The same simple file can still be loaded in a
shell with:

```bash
set -a
source /path/to/envfile
set +a
```

The example user service reads `%h/.envs/homelab_mcp.env`.

A user-service example is available at `examples/systemd/homelab_mcp.service`.
An envfile example is available at `examples/env/homelab_mcp.env.example`.

## Runtime naming and service management

- `private_mcp` is the Git repository and source directory.
- `private-mcp` is the npm package and MCP server identity.
- `homelab_mcp.service` is the **only** local HTTP MCP systemd service.
  It loads `%h/.envs/homelab_mcp.env` and runs `dist/index.js`.
- `openai-tunnel-client.service` is the OpenAI Tunnel service. It loads
  `%h/.config/homelab-mcp/openai-tunnel.env` and starts `dist/stdio.js`
  through its `homelab-stdio` profile.
- `cloudflared.service` is the shared Cloudflare Tunnel, configured in the
  separate `~/project/infra` Terraform repository. It routes
  `https://mcp.songlei.me/mcp` to HTTP port 8787.

Use `npm run http:status`, `npm run http:logs`, `npm run tunnel:status`,
and `npm run tunnel:logs` to inspect the active services. The HTTP installer
uses the existing `homelab_mcp.service` and preserves its unit file if it is
already installed. It will not create a second HTTP service.

## MCP protocol and deployment paths

Both entrypoints use @modelcontextprotocol/server 2.3.1 and the modern
2026-07-28 protocol. The old 2025 initialize/session handshake is rejected.
The SDK handles per-request isolation; no custom HTTP session map is used.

- Cloudflare + Auth0: src/index.ts -> /mcp at 127.0.0.1:8787, with verified
  JWT and per-tool scopes (mcp:read, mcp:write, mcp:command).
- OpenAI Secure MCP Tunnel: src/stdio.ts -> serveStdio, with no HTTP OAuth.
  The tunnel client launches dist/stdio.js; stdout is MCP-only.
- Both entrypoints register the same seven tools: read_logs, read_file,
  write_file, apply_patch, run_command, send_file, and recv_file.
  Existing five tools are unchanged. send_file requires mcp:write and uses
  OpenAI `openai/fileParams` with download_url/file_id (optional mime_type,
  file_name). It downloads only from approved OpenAI HTTPS hosts, streams at
  most 50 MiB, checks optional SHA-256, and does not overwrite by default.
  recv_file requires mcp:read and returns a base64-encoded embedded MCP
  resource, limited to 2 MiB. It does not automatically save to ChatGPT Library
  and does not require an additional public file endpoint.

The gateway and tunnel are enabled as systemd user services. User lingering
keeps them up without a desktop login. The command tool inherits the gateway
process environment and invokes /bin/bash -lc, so the login shell adds user
PATH configuration; environment values available only to an interactive shell
are not automatically guaranteed.

Run npm test, npm run build, and npm run test:local for protocol regression
checks. The latter runs in-process HTTP and a real stdio child without an
external OAuth bearer token.
