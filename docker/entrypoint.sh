#!/bin/sh
set -eu

HOME_DIR="${HOME:-/home/node}"
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME_DIR/.openclaw-dench}"
SERVER_PATH="$STATE_DIR/web-runtime/app/server.js"
WEB_PORT="${PORT:-3100}"
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"

if [ ! -f "$SERVER_PATH" ]; then
  node denchclaw.mjs bootstrap --skip-daemon-install --non-interactive --no-open
fi

if [ ! -f "$SERVER_PATH" ]; then
  echo "denchclaw-container-entrypoint: missing managed runtime server at $SERVER_PATH" >&2
  exit 1
fi

# Ensure no detached managed runtime is still holding the port before the
# foreground server starts.
node denchclaw.mjs stop --skip-daemon-install --web-port "$WEB_PORT" >/dev/null 2>&1 || true

i=0
while lsof -iTCP:"$WEB_PORT" -sTCP:LISTEN -n -P >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "denchclaw-container-entrypoint: port $WEB_PORT is still in use after stop" >&2
    lsof -iTCP:"$WEB_PORT" -sTCP:LISTEN -n -P >&2 || true
    exit 1
  fi
  sleep 1
done

exec env \
  PORT="$WEB_PORT" \
  HOSTNAME="0.0.0.0" \
  OPENCLAW_GATEWAY_PORT="$GATEWAY_PORT" \
  node "$SERVER_PATH"
