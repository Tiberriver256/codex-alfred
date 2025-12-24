#!/usr/bin/env bash
set -euo pipefail

EXTRA_ENV_ARGS=()
EXTRA_ENV_FILES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -e|--env)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for $1 (expected KEY=VALUE)" >&2
        exit 1
      fi
      if [[ "$2" != *"="* ]]; then
        echo "Invalid $1 value '$2' (expected KEY=VALUE)" >&2
        exit 1
      fi
      EXTRA_ENV_ARGS+=("-e" "$2")
      shift 2
      ;;
    --env-file)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for $1 (expected PATH)" >&2
        exit 1
      fi
      EXTRA_ENV_FILES+=("--env-file" "$2")
      shift 2
      ;;
    --env-file=*)
      ENV_FILE="${1#*=}"
      EXTRA_ENV_FILES+=("--env-file" "$ENV_FILE")
      shift
      ;;
    --env=*)
      ENV_VALUE="${1#*=}"
      if [[ "$ENV_VALUE" != *"="* ]]; then
        echo "Invalid --env value '$ENV_VALUE' (expected KEY=VALUE)" >&2
        exit 1
      fi
      EXTRA_ENV_ARGS+=("-e" "$ENV_VALUE")
      shift
      ;;
    -h|--help)
      cat <<'EOF'
Usage: ./alfred-docker.sh [--env KEY=VALUE]...

Options:
  -e, --env KEY=VALUE   Add an extra environment variable for the container
  --env-file PATH       Add environment variables from a file (docker --env-file format)
  -h, --help            Show this help
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

DATA_DIR="${ALFRED_DATA_DIR:-$HOME/mom-data}"
IMAGE_NAME="${ALFRED_IMAGE:-codex-alfred:local}"
CODEX_HOME_HOST="${CODEX_HOME:-$HOME/.codex}"
CODEX_HOME_DOCKER="/codex-home"
ENGINE_DIR="/alfred"
PID_FILE="${ALFRED_PID_FILE:-$CODEX_HOME_HOST/alfred.pid}"
DOCKER_PID_FILE="$CODEX_HOME_DOCKER/alfred.pid"
DOCKER_LOG_FILE="$CODEX_HOME_DOCKER/alfred.log"

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

docker build -t "$IMAGE_NAME" .
IMAGE_ID=$(docker image inspect "$IMAGE_NAME" --format '{{.Id}}')

if ! docker inspect "$NAME" >/dev/null 2>&1; then
  SANDBOX_NAME="$NAME" SANDBOX_IMAGE="$IMAGE_NAME" ./docker.sh create "$DATA_DIR"
else
  CONTAINER_IMAGE_ID=$(docker inspect -f '{{.Image}}' "$NAME")
  if [[ "$CONTAINER_IMAGE_ID" != "$IMAGE_ID" ]]; then
    docker rm -f "$NAME" >/dev/null
    SANDBOX_NAME="$NAME" SANDBOX_IMAGE="$IMAGE_NAME" ./docker.sh create "$DATA_DIR"
  fi
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

docker exec "$NAME" sh -lc "mkdir -p \"$CODEX_HOME_DOCKER\""
if [[ -d "$CODEX_HOME_HOST" ]]; then
  docker cp "$CODEX_HOME_HOST/." "$NAME:$CODEX_HOME_DOCKER"
fi

docker exec "$NAME" sh -lc "if [ -f \"$DOCKER_PID_FILE\" ]; then PID=\$(cat \"$DOCKER_PID_FILE\" || true); if [ -n \"\$PID\" ]; then kill -0 \"\$PID\" 2>/dev/null && kill \"\$PID\" || true; fi; fi"
sleep 1

ENV_ARGS=()
for var in SLACK_APP_TOKEN SLACK_BOT_TOKEN ALFRED_LOG_LEVEL OPENAI_API_KEY CODEX_HOME; do
  if [[ -n "${!var:-}" ]]; then
    ENV_ARGS+=("-e" "${var}=${!var}")
  fi
done

if [[ -f ".env" ]]; then
  EXTRA_ENV_FILES+=("--env-file" ".env")
fi

ENV_ARGS+=("${EXTRA_ENV_ARGS[@]}")
ENV_ARGS+=("${EXTRA_ENV_FILES[@]}")
ENV_ARGS+=("-e" "ALFRED_DATA_DIR=/workspace")
ENV_ARGS+=("-e" "CODEX_HOME=$CODEX_HOME_DOCKER")
ENV_ARGS+=("-e" "ALFRED_SANDBOX=host")
ENV_ARGS+=("-e" "ALFRED_WORKDIR=/workspace")

docker exec "${ENV_ARGS[@]}" "$NAME" sh -lc "cd \"$ENGINE_DIR\" && nohup node \"$ENGINE_DIR/dist/index.js\" --log-level debug -- --yolo > \"$DOCKER_LOG_FILE\" 2>&1 & echo \$! > \"$DOCKER_PID_FILE\""

if [[ -f "$PID_FILE" ]]; then
  cat "$PID_FILE"
fi
