#!/usr/bin/env bash
set -u

BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
AUTH_HEADER=()
FAILED=0
if [[ -n "${MCP_STATIC_BEARER_TOKEN:-}" ]]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${MCP_STATIC_BEARER_TOKEN}")
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "${tmpdir}"' EXIT

fail() {
  echo "BAD: $1" >&2
  FAILED=1
  return 0
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  if ! grep -qF "$needle" <<<"$haystack"; then
    fail "expected output to contain: $needle"
    return 1
  fi
}

echo "== healthz =="
healthz="$(curl -sS "${BASE_URL}/healthz")" || fail "healthz request failed"
printf '%s\n' "${healthz}"
assert_contains "${healthz}" '"status":"ok"'

echo "== initialize =="
initialize="$(curl -sS "${BASE_URL}/mcp" \
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
  }')" || fail "initialize request failed"
printf '%s\n' "${initialize}"
assert_contains "${initialize}" '"protocolVersion":"2025-06-18"'

echo "== tools/list =="
tools_list="$(curl -sS "${BASE_URL}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  "${AUTH_HEADER[@]}" \
  --data '{
    "jsonrpc":"2.0",
    "id":2,
    "method":"tools/list",
    "params":{}
  }')" || fail "tools/list request failed"
printf '%s\n' "${tools_list}"
for tool in read_logs read_file write_file apply_patch run_command; do
  assert_contains "${tools_list}" "\"name\":\"${tool}\""
done
old_tool="run""_date"
if grep -q "\"name\":\"${old_tool}\"" <<<"${tools_list}"; then
  fail "old tool should not be listed"
fi

echo "== run_command smoke =="
run_command="$(curl -sS "${BASE_URL}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  "${AUTH_HEADER[@]}" \
  --data '{
    "jsonrpc":"2.0",
    "id":3,
    "method":"tools/call",
    "params":{"name":"run_command","arguments":{"command":"printf smoke","cwd":"'"${tmpdir}"'","timeoutMs":2000,"maxOutputBytes":4096}}
  }')" || fail "run_command request failed"
printf '%s\n' "${run_command}"
assert_contains "${run_command}" 'smoke'

echo "== write/read smoke =="
smoke_file="${tmpdir}/smoke.txt"
write_file="$(curl -sS "${BASE_URL}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  "${AUTH_HEADER[@]}" \
  --data '{
    "jsonrpc":"2.0",
    "id":4,
    "method":"tools/call",
    "params":{"name":"write_file","arguments":{"path":"'"${smoke_file}"'","content":"hello","createParentDirs":true}}
  }')" || fail "write_file request failed"
printf '%s\n' "${write_file}"
assert_contains "${write_file}" 'ok'

read_file="$(curl -sS "${BASE_URL}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  "${AUTH_HEADER[@]}" \
  --data '{
    "jsonrpc":"2.0",
    "id":5,
    "method":"tools/call",
    "params":{"name":"read_file","arguments":{"path":"'"${smoke_file}"'","maxBytes":16}}
  }')" || fail "read_file request failed"
printf '%s\n' "${read_file}"
assert_contains "${read_file}" 'hello'

echo "== apply_patch smoke =="
patch_file="${tmpdir}/smoke.diff"
cat > "${patch_file}" <<'EOF'
--- a/smoke-validate.txt
+++ b/smoke-validate.txt
@@ -0,0 +1 @@
+patched
EOF
patch_payload="$(python3 - <<'PY' "${patch_file}"
import json
import sys
from pathlib import Path
print(json.dumps(Path(sys.argv[1]).read_text()))
PY
)"
apply_patch="$(curl -sS "${BASE_URL}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  "${AUTH_HEADER[@]}" \
  --data "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"apply_patch\",\"arguments\":{\"cwd\":\"${tmpdir}\",\"patch\":${patch_payload},\"strip\":1}}}")" || fail "apply_patch request failed"
printf '%s\n' "${apply_patch}"
if ! grep -qE 'patching file|success|applied|patched' <<<"${apply_patch}"; then
  if ! grep -qF 'patched' "${tmpdir}/smoke-validate.txt"; then
    fail "apply_patch did not change the file"
  fi
fi

echo "== read_logs smoke =="
log_file="${tmpdir}/local.log"
printf 'alpha\nmarker-123\nomega\n' > "${log_file}"
read_logs="$(curl -sS "${BASE_URL}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  "${AUTH_HEADER[@]}" \
  --data '{
    "jsonrpc":"2.0",
    "id":7,
    "method":"tools/call",
    "params":{"name":"read_logs","arguments":{"source":"file","path":"'"${log_file}"'","lines":2,"maxOutputBytes":256}}
  }')" || fail "read_logs request failed"
printf '%s\n' "${read_logs}"
assert_contains "${read_logs}" 'marker-123'

[ "${FAILED}" -eq 0 ]
