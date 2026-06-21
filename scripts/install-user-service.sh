#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
UNIT_DIR="${HOME}/.config/systemd/user"
UNIT_FILE="${UNIT_DIR}/mcp-local-gateway.service"
NODE_BIN="$(command -v node)"

command -v systemctl >/dev/null
systemctl --user --version >/dev/null

mkdir -p "${REPO_ROOT}/logs"

if [[ -f "${REPO_ROOT}/.env" ]]; then
  echo "Using optional environment file: ${REPO_ROOT}/.env"
else
  echo "No .env found; using built-in defaults."
fi

cd "${REPO_ROOT}"
npm ci
npm run build

mkdir -p "${UNIT_DIR}"
cat > "${UNIT_FILE}" <<EOF
[Unit]
Description=mcp-local-gateway

[Service]
WorkingDirectory=${REPO_ROOT}
Environment=NODE_ENV=production
EnvironmentFile=-${REPO_ROOT}/.env
ExecStart=${NODE_BIN} ${REPO_ROOT}/dist/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable mcp-local-gateway.service
systemctl --user restart mcp-local-gateway.service
systemctl --user status mcp-local-gateway.service --no-pager
for _ in {1..20}; do
  if curl -fsS http://127.0.0.1:8787/healthz; then
    exit 0
  fi
  sleep 0.5
done

echo "mcp-local-gateway health check failed" >&2
systemctl --user status mcp-local-gateway.service --no-pager || true
exit 1
