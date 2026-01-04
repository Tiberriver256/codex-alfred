#!/usr/bin/env bash
set -euo pipefail

IMAGE="${SANDBOX_IMAGE:-ghcr.io/astral-sh/uv:python3.11-bookworm-slim}"
DEFAULT_NAME="codex-alfred-sandbox"

usage() {
  cat <<USAGE
Usage: ./docker.sh <command> [args]

Commands:
  create [data-dir]   Create the sandbox container (mounts data-dir to /workspace)
  start               Start the container
  stop                Stop the container
  remove              Remove the container
  status              Show container status
  shell               Open a shell inside the container

Env:
  SANDBOX_NAME        Override the default container name (${DEFAULT_NAME})
  SANDBOX_IMAGE       Override the container image (${IMAGE})
USAGE
}

abs_path() {
  if command -v realpath >/dev/null 2>&1; then
    realpath "$1"
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$1" <<'PY'
import os
import sys
print(os.path.abspath(sys.argv[1]))
PY
  else
    (cd "$1" && pwd -P)
  fi
}

COMMAND=${1:-}
NAME=${SANDBOX_NAME:-$DEFAULT_NAME}

if [[ -z "$COMMAND" ]]; then
  usage
  exit 1
fi

case "$COMMAND" in
  create)
    DATA_DIR=${2:-"$(pwd)"}
    ABS_DIR=$(abs_path "$DATA_DIR")
    docker create \
      --name "$NAME" \
      --network host \
      --device-cgroup-rule='c 189:* rmw' \
      -v /dev/bus/usb:/dev/bus/usb \
      -v "$ABS_DIR:/workspace" \
      "$IMAGE" \
      sh -c "tail -f /dev/null" >/dev/null
    echo "Created container $NAME with /workspace -> $ABS_DIR"
    ;;
  start)
    docker start "$NAME" >/dev/null
    echo "Started $NAME"
    ;;
  stop)
    docker stop "$NAME" >/dev/null
    echo "Stopped $NAME"
    ;;
  remove)
    docker rm -f "$NAME" >/dev/null
    echo "Removed $NAME"
    ;;
  status)
    docker inspect -f '{{.Name}}: {{.State.Status}}' "$NAME"
    ;;
  shell)
    docker exec -it "$NAME" sh
    ;;
  *)
    usage
    exit 1
    ;;
 esac
