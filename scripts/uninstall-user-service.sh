#!/usr/bin/env bash
set -euo pipefail

UNIT_DIR="${HOME}/.config/systemd/user"
UNIT_FILE="${UNIT_DIR}/mcp-local-gateway.service"

command -v systemctl >/dev/null
systemctl --user --version >/dev/null

systemctl --user stop mcp-local-gateway.service || true
systemctl --user disable mcp-local-gateway.service || true
rm -f "${UNIT_FILE}"
systemctl --user daemon-reload
systemctl --user reset-failed mcp-local-gateway.service || true
