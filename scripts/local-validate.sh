#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
AUTH_HEADER=()
if [[ -n "${MCP_STATIC_BEARER_TOKEN:-}" ]]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${MCP_STATIC_BEARER_TOKEN}")
fi

echo "== healthz =="
curl -sS "${BASE_URL}/healthz"
echo

echo
echo "== initialize =="
curl -i -sS "${BASE_URL}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  "${AUTH_HEADER[@]}" \
  --data '{
    "jsonrpc":"2.0",
    "id":1,
    "method":"initialize",
    "params":{
      "protocolVersion":"2025-06-18",
      "capabilities":{},
      "clientInfo":{"name":"local-curl","version":"0.0.1"}
    }
  }'
echo

echo
echo "== tools/list =="
curl -i -sS "${BASE_URL}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  "${AUTH_HEADER[@]}" \
  --data '{
    "jsonrpc":"2.0",
    "id":2,
    "method":"tools/list",
    "params":{}
  }'
echo

echo
echo "== tools/call run_date =="
curl -i -sS "${BASE_URL}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  "${AUTH_HEADER[@]}" \
  --data '{
    "jsonrpc":"2.0",
    "id":3,
    "method":"tools/call",
    "params":{"name":"run_date","arguments":{}}
  }'
echo
