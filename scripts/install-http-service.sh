#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
UNIT_NAME="homelab_mcp.service"
UNIT_FILE="${HOME}/.config/systemd/user/${UNIT_NAME}"
UNIT_TEMPLATE="${REPO_ROOT}/examples/systemd/homelab_mcp.service"
ENV_FILE="${HOME}/.envs/homelab_mcp.env"

command -v systemctl >/dev/null
systemctl --user --version >/dev/null

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing HTTP OAuth environment file: ${ENV_FILE}" >&2
  exit 1
fi

cd "${REPO_ROOT}"
npm ci
npm run build

mkdir -p "$(dirname "${UNIT_FILE}")"
if [[ -f "${UNIT_FILE}" ]]; then
  echo "Preserving existing ${UNIT_NAME}; no unit file was overwritten."
else
  install -m 0644 "${UNIT_TEMPLATE}" "${UNIT_FILE}"
fi

systemctl --user daemon-reload
systemctl --user enable "${UNIT_NAME}"
systemctl --user restart "${UNIT_NAME}"
systemctl --user status "${UNIT_NAME}" --no-pager

for _ in {1..20}; do
  if curl -fsS http://127.0.0.1:8787/healthz >/dev/null; then
    echo "${UNIT_NAME} is healthy"
    exit 0
  fi
  sleep 0.5
done

echo "${UNIT_NAME} health check failed" >&2
systemctl --user status "${UNIT_NAME}" --no-pager || true
exit 1
