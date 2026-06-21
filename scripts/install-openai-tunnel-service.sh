#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
UNIT_DIR="${HOME}/.config/systemd/user"
UNIT_FILE="${UNIT_DIR}/openai-tunnel-client.service"
ENV_FILE="${HOME}/.config/homelab-mcp/openai-tunnel.env"
PROFILE_FILE="${HOME}/.config/tunnel-client/homelab-stdio.yaml"
HEALTH_URL_FILE="/tmp/homelab-openai-tunnel-stdio-health.url"

command -v systemctl >/dev/null
systemctl --user --version >/dev/null
command -v tunnel-client >/dev/null

if [[ ! -x "$(command -v tunnel-client)" ]]; then
  echo "tunnel-client executable is not available or not executable" >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing environment file: ${ENV_FILE}" >&2
  exit 1
fi

if [[ ! -f "${PROFILE_FILE}" ]]; then
  echo "Missing tunnel profile file: ${PROFILE_FILE}" >&2
  exit 1
fi

cd "${REPO_ROOT}"
npm ci
npm run build

mkdir -p "${UNIT_DIR}"
cat > "${UNIT_FILE}" <<EOF
[Unit]
Description=openai-tunnel-client

[Service]
WorkingDirectory=${REPO_ROOT}
EnvironmentFile=${ENV_FILE}
ExecStart=$(command -v tunnel-client) run --profile homelab-stdio --health.listen-addr 127.0.0.1:18080 --health.url-file ${HEALTH_URL_FILE} --log.file /tmp/homelab-openai-tunnel-stdio.log
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable openai-tunnel-client.service
systemctl --user restart openai-tunnel-client.service
systemctl --user status openai-tunnel-client.service --no-pager

for _ in {1..60}; do
  if [[ -f "${HEALTH_URL_FILE}" ]]; then
    HEALTH_BASE_URL="$(tr -d '[:space:]' < "${HEALTH_URL_FILE}")"
    if [[ -n "${HEALTH_BASE_URL}" ]]; then
      if curl -fsS "${HEALTH_BASE_URL%/}/healthz" >/dev/null && curl -fsS "${HEALTH_BASE_URL%/}/readyz" >/dev/null; then
        exit 0
      fi
    fi
  fi
  sleep 0.5
done

echo "openai-tunnel-client health check failed" >&2
systemctl --user status openai-tunnel-client.service --no-pager || true
exit 1
