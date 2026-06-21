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

curl_mcp() {
  local response_file="$1"
  shift
  local status_file
  status_file="$(mktemp)"
  curl -sS --max-time 10 "$@" -o "${response_file}" -w '%{http_code} %{errormsg}' >"${status_file}"
  CURL_RC=$?
  CURL_STATUS="$(cat "${status_file}")"
  printf '%s\n' "${CURL_STATUS}"
  rm -f "${status_file}"
  return 0
}

is_valid_jsonrpc_response() {
  local payload="$1"
  grep -qF '"jsonrpc":"2.0"' <<<"${payload}" && grep -qF '"id":1' <<<"${payload}" && {
    grep -qF '"result":' <<<"${payload}" || grep -qF '"error":' <<<"${payload}"
  }
}

echo "== healthz =="
healthz="$(curl -sS --max-time 10 "${BASE_URL}/healthz")" || fail "healthz request failed"
printf '%s\n' "${healthz}"
assert_contains "${healthz}" '"status":"ok"'

echo "== initialize =="
initialize_file="${tmpdir}/initialize.json"
curl_mcp "${initialize_file}" "${BASE_URL}/mcp" \
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
initialize="$(cat "${initialize_file}")"
printf '%s\n' "${initialize}"
if ! is_valid_jsonrpc_response "${initialize}"; then
  fail "initialize response missing valid jsonrpc payload"
fi
if [[ "${CURL_RC:-0}" -ne 0 && -z "${initialize}" ]]; then
  fail "initialize timed out before receiving a response"
fi

echo "== tools/list =="
tools_list_file="${tmpdir}/tools-list.json"
curl_mcp "${tools_list_file}" "${BASE_URL}/mcp" \
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
tools_list="$(cat "${tools_list_file}")"
printf '%s\n' "${tools_list}"
for tool in read_logs read_file write_file apply_patch run_command; do
  assert_contains "${tools_list}" "\"name\":\"${tool}\""
done
old_tool="run""_date"
if grep -q "\"name\":\"${old_tool}\"" <<<"${tools_list}"; then
  fail "old tool should not be listed"
fi

echo "== stdio entry exists =="
if [[ ! -f dist/stdio.js ]]; then
  fail "dist/stdio.js missing"
fi
if ! grep -qF 'StdioServerTransport' dist/stdio.js; then
  fail "dist/stdio.js does not reference StdioServerTransport"
fi

echo "== stdio smoke =="
stdio_out="${tmpdir}/stdio.out"
stdio_err="${tmpdir}/stdio.err"
timeout 2s node dist/stdio.js >"${stdio_out}" 2>"${stdio_err}" <<EOF || true
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"local-stdio","version":"0.0.1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"run_command","arguments":{"command":"printf stdio-smoke","cwd":"${tmpdir}","timeoutMs":2000,"maxOutputBytes":4096}}}
EOF
if ! grep -qF 'mcp-local-gateway stdio transport starting' "${stdio_err}"; then
  fail "stdio startup log missing from stderr"
fi
if grep -qE 'timestamp|tool\.policy|tool\.exec|requestId|decision' "${stdio_out}"; then
  fail "stdio stdout leaked audit fields"
fi
while IFS= read -r line; do
  [[ -z "${line}" ]] && continue
  if ! python3 - <<'PY' "${line}" >/dev/null 2>&1; then
import json
import sys
obj = json.loads(sys.argv[1])
raise SystemExit(0 if isinstance(obj, dict) and obj.get("jsonrpc") == "2.0" else 1)
PY
    fail "stdio stdout contained non-MCP output: ${line}"
  fi
done < "${stdio_out}"
if ! grep -qF 'stdio-smoke' "${stdio_out}"; then
  fail "stdio run_command response missing stdio-smoke"
fi

echo "== run_command smoke =="
run_command_file="${tmpdir}/run-command.json"
curl_mcp "${run_command_file}" "${BASE_URL}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  "${AUTH_HEADER[@]}" \
  --data '{
    "jsonrpc":"2.0",
    "id":3,
    "method":"tools/call",
    "params":{"name":"run_command","arguments":{"command":"printf smoke","cwd":"'"${tmpdir}"'","timeoutMs":2000,"maxOutputBytes":4096}}
  }'
run_command="$(cat "${run_command_file}")"
printf '%s\n' "${run_command}"
assert_contains "${run_command}" 'smoke'

echo "== write/read smoke =="
smoke_file="${tmpdir}/smoke.txt"
write_file_file="${tmpdir}/write-file.json"
curl_mcp "${write_file_file}" "${BASE_URL}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  "${AUTH_HEADER[@]}" \
  --data '{
    "jsonrpc":"2.0",
    "id":4,
    "method":"tools/call",
    "params":{"name":"write_file","arguments":{"path":"'"${smoke_file}"'","content":"hello","createParentDirs":true}}
  }'
write_file="$(cat "${write_file_file}")"
printf '%s\n' "${write_file}"
assert_contains "${write_file}" 'ok'

read_file_file="${tmpdir}/read-file.json"
curl_mcp "${read_file_file}" "${BASE_URL}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  "${AUTH_HEADER[@]}" \
  --data '{
    "jsonrpc":"2.0",
    "id":5,
    "method":"tools/call",
    "params":{"name":"read_file","arguments":{"path":"'"${smoke_file}"'","maxBytes":16}}
  }'
read_file="$(cat "${read_file_file}")"
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
apply_patch_file="${tmpdir}/apply-patch.json"
curl_mcp "${apply_patch_file}" "${BASE_URL}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  "${AUTH_HEADER[@]}" \
  --data "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"apply_patch\",\"arguments\":{\"cwd\":\"${tmpdir}\",\"patch\":${patch_payload},\"strip\":1}}}"
apply_patch="$(cat "${apply_patch_file}")"
printf '%s\n' "${apply_patch}"
if ! grep -qE 'patching file|success|applied|patched' <<<"${apply_patch}"; then
  if ! grep -qF 'patched' "${tmpdir}/smoke-validate.txt"; then
    fail "apply_patch did not change the file"
  fi
fi

echo "== read_logs smoke =="
log_file="${tmpdir}/local.log"
printf 'alpha\nmarker-123\nomega\n' > "${log_file}"
read_logs_file="${tmpdir}/read-logs.json"
curl_mcp "${read_logs_file}" "${BASE_URL}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  "${AUTH_HEADER[@]}" \
  --data '{
    "jsonrpc":"2.0",
    "id":7,
    "method":"tools/call",
    "params":{"name":"read_logs","arguments":{"source":"file","path":"'"${log_file}"'","lines":2,"maxOutputBytes":256}}
  }'
read_logs="$(cat "${read_logs_file}")"
printf '%s\n' "${read_logs}"
assert_contains "${read_logs}" 'marker-123'

[ "${FAILED}" -eq 0 ]
