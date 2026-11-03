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
- `openai-tunnel-client.service` connects to the **same HTTP backend** via
  `http://127.0.0.1:8787/mcp` using the `homelab-http` tunnel profile.
  It loads both its existing control-plane environment and
  `%h/.envs/homelab_mcp.env` for `MCP_TUNNEL_TOKEN`.
- `cloudflared.service` is the shared Cloudflare Tunnel, configured in the
  separate `~/project/infra` Terraform repository. It routes
  `https://mcp.songlei.me/mcp` to HTTP port 8787.

Use `npm run http:status`, `npm run http:logs`, `npm run tunnel:status`,
and `npm run tunnel:logs` to inspect the active services. The HTTP installer
uses the existing `homelab_mcp.service` and preserves its unit file if it is
already installed. It will not create a second HTTP service.

## MCP protocol and deployment paths

Both routes use one `@modelcontextprotocol/server` HTTP runtime (2.3.1) and
the modern 2026-07-28 protocol. It also accepts 2025-era stateless MCP initialization.
The SDK handles per-request isolation; no custom HTTP session map is used.

- Cloudflare + Auth0: src/index.ts -> /mcp at 127.0.0.1:8787, with verified
  JWT and per-tool scopes (mcp:read, mcp:write, mcp:command).
- OpenAI Secure MCP Tunnel: local HTTP requests to that **same**
  `src/index.ts` process. Its `X-MCP-Tunnel-Token` is verified separately
  from public Auth0 JWTs, never by trusting a loopback source address.
  Put the single high-entropy `MCP_TUNNEL_TOKEN` in
  `%h/.envs/homelab_mcp.env`; the tunnel profile uses `env:MCP_TUNNEL_TOKEN`
  for both runtime and discovery/probe headers.
- Both connections use the same seven core tools: read_logs, read_file,
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
checks. The latter checks the HTTP backend in-process without an
external OAuth bearer token.

## Dangerous compatibility mode

Run `npm run start -- --dangerous` to advertise all MCP tools,
including dynamically discovered Playwright tools, with `readOnlyHint: true`,
`destructiveHint: false`, `idempotentHint: true`, and `openWorldHint: false`.
Without the flag, real annotations are retained. This changes advertised
metadata only: actual tool capabilities, OAuth scopes and server-side policy
remain unchanged. Clients may ignore these hints, or auto-approve dangerous
commands. Do not enable this mode for untrusted agents or endpoints.

## Webhook SSRF policy

Outgoing MCP Events webhook requests are HTTPS-only and reject private, reserved,
link-local and metadata destinations by default. Redirects are not followed;
HTTPS certificate validation, response limits and socket-level address checks
remain enabled regardless of the SSRF policy.

Optional environment variables (apply to the shared HTTP backend):

```env
WEBHOOK_SSRF_ENABLED=true
WEBHOOK_SSRF_ALLOWED_HOSTNAMES=connectors.api.openai.com
WEBHOOK_SSRF_ALLOWED_IP_RANGES=198.18.0.0/15
```

The last two settings must **both** match a webhook destination before the
otherwise-blocked IP is permitted. Domains may be comma-separated exact names
or anchored subdomain patterns such as `*.example.com`; CIDRs may be IPv4 or
IPv6. Defaults: SSRF filtering enabled, with no exceptions. When enabled,
setting only one half of an exception is an invalid configuration.

This example is useful with Clash/OpenClash Fake-IP: it permits only the
specified HTTPS callback hostname when it resolves inside the local Fake-IP
range, without changing system or router DNS and without granting unrestricted
access to that network range. Cloud metadata and link-local addresses are
blocked even under an exception. To explicitly disable IP-based SSRF checks,
set `WEBHOOK_SSRF_ENABLED=false` (not recommended for shared deployments).

## Playwright browser tools

At gateway startup, the native tools from the pinned `@playwright/mcp` are discovered
and exposed with their original tool names, descriptions, and schemas. Each tool
has one additional optional `browserType` field (default: `chrome`):

- `chrome`: connect to the user's existing Google Chrome session via the
  Playwright Extension. Requires `PLAYWRIGHT_MCP_EXTENSION_TOKEN` in the running
  gateway's environment; if absent, the tool reports an error immediately.
- `chromium`: run independent headless Chrome (`--browser=chrome --headless`).
- `msedge`, `firefox`, `webkit`: launch the corresponding independent headless
  browser via the native Playwright `--browser` option. The browser binary must
  be installed locally.

The `chromium` value is a gateway alias for independent headless Chrome, not a
native value of `@playwright/mcp@0.0.83`'s `--browser` option. Each browserType
has its own reusable internal stdio MCP client and retains browser state across calls.
Independent headless browser modes use `--isolated` to avoid sharing their default
browser profiles.
Use a consistent browserType for multi-step tasks. The gateway disconnects
its MCP children on shutdown, without closing the user's Chrome.

The extension token is read from `process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN`
and forwarded under that **exact** official name to the child process. No token
is supplied as a CLI argument, stored in code, or added to tool metadata.
`PLAYWRIGHT_MCP_PROFILE_DIR_NAME` may optionally target a particular Chrome
profile. The extension still must be installed and able to connect.

Playwright snapshots and generated outputs use a temporary directory outside
the Git working tree. Browser operations require the existing `mcp:command`
OAuth scope. `PLAYWRIGHT_MCP_ENABLED=false` disables all browser tools, without
affecting the existing tools or either HTTP connection.

The external Cloudflare and OpenAI tunnels share one HTTP runtime. There is no
separate stdio gateway process or cross-process notification socket. Resource
change notifications are sent through the shared HTTP event bus.

The `@playwright/mcp` JSON tool schemas are converted once during tool discovery
and reused by all requests. Individual `McpServer` instances are still created
per request to preserve authorization and client isolation.
