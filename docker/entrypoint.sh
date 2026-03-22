#!/bin/sh
set -eu

HOME_DIR="${HOME:-/home/node}"
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME_DIR/.openclaw-dench}"
SERVER_PATH="$STATE_DIR/web-runtime/app/server.js"
WEB_PORT="${PORT:-3100}"
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"

node denchclaw.mjs bootstrap --skip-daemon-install --non-interactive --no-open

if [ ! -f "$SERVER_PATH" ]; then
  echo "denchclaw-container-entrypoint: missing managed runtime server at $SERVER_PATH" >&2
  exit 1
fi

exec env \
  PORT="$WEB_PORT" \
  HOSTNAME="0.0.0.0" \
  OPENCLAW_GATEWAY_PORT="$GATEWAY_PORT" \
  node "$SERVER_PATH"
