#!/usr/bin/env bash
# Bridge Windows Cursor CDP (127.0.0.1:9333) into WSL localhost:9333.
# Requires Windows Node relay on 0.0.0.0:19333 (cdp-relay-9333.js).
set -euo pipefail
GATEWAY=$(ip route | awk '/default/{print $3; exit}')
RELAY_PORT=${RELAY_PORT:-19333}
WIN_RELAY='C:\Users\jonbo\AppData\Local\Temp\cdp-relay-9333.js'

# Ensure Windows user-mode relay is up
if ! curl -sf -m 2 "http://${GATEWAY}:${RELAY_PORT}/json/version" >/dev/null; then
  cmd.exe /c "start /b \"\" \"C:\Program Files\nodejs\node.exe\" ${WIN_RELAY}" >/dev/null 2>&1 || true
  sleep 1
fi

pkill -f 'socat TCP-LISTEN:9333' 2>/dev/null || true
fuser -k 9333/tcp 2>/dev/null || true
sleep 0.2
exec socat TCP-LISTEN:9333,bind=127.0.0.1,fork,reuseaddr "TCP:${GATEWAY}:${RELAY_PORT}"
