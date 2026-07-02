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

A user-service example is available at `examples/systemd/mcp-oauth.service`.
An envfile example is available at `examples/env/mcp-oauth.env.example`.
