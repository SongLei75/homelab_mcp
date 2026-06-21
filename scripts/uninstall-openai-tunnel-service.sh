#!/usr/bin/env bash
set -euo pipefail

UNIT_DIR="${HOME}/.config/systemd/user"
UNIT_FILE="${UNIT_DIR}/openai-tunnel-client.service"

command -v systemctl >/dev/null
systemctl --user --version >/dev/null

systemctl --user stop openai-tunnel-client.service || true
systemctl --user disable openai-tunnel-client.service || true
rm -f "${UNIT_FILE}"
systemctl --user daemon-reload
