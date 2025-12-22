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

if ! docker inspect "$NAME" >/dev/null 2>&1; then
  SANDBOX_NAME="$NAME" ./docker.sh create "$DATA_DIR"
fi

STATUS=$(docker inspect -f '{{.State.Status}}' "$NAME")
if [[ "$STATUS" != "running" ]]; then
  SANDBOX_NAME="$NAME" ./docker.sh start
fi

if [[ -f "$PID_FILE" ]]; then
  PID=$(cat "$PID_FILE" || true)
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    sleep 1
  fi
fi

eval "$(mise activate zsh)"
ALFRED_DATA_DIR="$DATA_DIR" \
ALFRED_SANDBOX="docker:$NAME" \
ALFRED_WORKDIR="/workspace" \
nohup codex-alfred --log-level debug > "$DATA_DIR/alfred.log" 2>&1 & echo $! | tee "$PID_FILE"
