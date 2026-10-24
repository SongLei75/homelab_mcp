#!/usr/bin/env bash
set -euo pipefail

UNIT_NAME="homelab_mcp.service"
UNIT_FILE="${HOME}/.config/systemd/user/${UNIT_NAME}"

command -v systemctl >/dev/null
systemctl --user --version >/dev/null

systemctl --user stop "${UNIT_NAME}" || true
systemctl --user disable "${UNIT_NAME}" || true

if [[ -f "${UNIT_FILE}" ]]; then
  rm "${UNIT_FILE}"
fi

systemctl --user daemon-reload
systemctl --user reset-failed "${UNIT_NAME}" || true
