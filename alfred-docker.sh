#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${ALFRED_DATA_DIR:-$HOME/mom-data}"
PID_FILE="${ALFRED_PID_FILE:-$DATA_DIR/alfred.pid}"

if [[ -n "${SANDBOX_NAME:-}" ]]; then
  NAME="$SANDBOX_NAME"
elif docker inspect mom-sandbox >/dev/null 2>&1; then
  NAME="mom-sandbox"
else
  NAME="codex-alfred-sandbox"
fi

mkdir -p "$DATA_DIR"

if [[ "${ALFRED_SKIP_BUILD:-0}" != "1" ]]; then
  npm run build
fi

if ! docker inspect "$NAME" >/dev/null 2>&1; then
  SANDBOX_NAME="$NAME" ./docker.sh create "$DATA_DIR"
fi

STATUS=$(docker inspect -f '{{.State.Status}}' "$NAME")
if [[ "$STATUS" != "running" ]]; then
  SANDBOX_NAME="$NAME" ./docker.sh start
fi

if [[ "${ALFRED_STOP_HOST:-1}" == "1" ]]; then
  if command -v pgrep >/dev/null 2>&1; then
    HOST_PIDS=$(pgrep -f "codex-alfred" || true)
    if [[ -n "$HOST_PIDS" ]]; then
      kill $HOST_PIDS || true
      sleep 1
    fi
  fi
fi

if [[ -f "$PID_FILE" ]]; then
  PID=$(cat "$PID_FILE" || true)
  if [[ -n "$PID" ]]; then
    docker exec "$NAME" sh -lc "kill -0 $PID 2>/dev/null && kill $PID || true"
    sleep 1
  fi
fi

if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete dist/ "$DATA_DIR/dist/"
  rsync -a --delete schemas/ "$DATA_DIR/schemas/"
else
  rm -rf "$DATA_DIR/dist" "$DATA_DIR/schemas"
  cp -R dist "$DATA_DIR/dist"
  cp -R schemas "$DATA_DIR/schemas"
fi

cp conversations-in-blockkit.md "$DATA_DIR/conversations-in-blockkit.md"

ENV_ARGS=()
for var in SLACK_APP_TOKEN SLACK_BOT_TOKEN ALFRED_LOG_LEVEL OPENAI_API_KEY CODEX_HOME; do
  if [[ -n "${!var:-}" ]]; then
    ENV_ARGS+=("-e" "${var}=${!var}")
  fi
done

ENV_ARGS+=("-e" "ALFRED_DATA_DIR=/workspace")
ENV_ARGS+=("-e" "ALFRED_SANDBOX=host")
ENV_ARGS+=("-e" "ALFRED_WORKDIR=/workspace")

docker exec "${ENV_ARGS[@]}" "$NAME" sh -lc "cd /workspace && nohup node /workspace/dist/index.js --log-level debug > /workspace/alfred.log 2>&1 & echo \$! > /workspace/alfred.pid"

if [[ -f "$PID_FILE" ]]; then
  cat "$PID_FILE"
fi
