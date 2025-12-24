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
CODEX_HOME_HOST="${CODEX_HOME:-$HOME/.codex}"
CODEX_HOME_DOCKER="/codex-home"
ENGINE_DIR="/alfred"
PID_FILE="${ALFRED_PID_FILE:-$DATA_DIR/alfred.pid}"
DOCKER_PID_FILE="$CODEX_HOME_DOCKER/alfred.pid"

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

if ! docker exec "$NAME" sh -lc "node -e 'const major=Number(process.versions.node.split(\".\")[0]); process.exit(Number.isFinite(major) && major >= 24 ? 0 : 1);'"; then
  echo "Installing Node.js 24 in $NAME..."
  docker exec "$NAME" sh -lc "apt-get update \
    && apt-get install -y ca-certificates curl gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main' > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*"
fi

docker exec "$NAME" sh -lc "mkdir -p \"$CODEX_HOME_DOCKER\""
if [[ -d "$CODEX_HOME_HOST" ]]; then
  docker cp "$CODEX_HOME_HOST/." "$NAME:$CODEX_HOME_DOCKER"
fi
if [[ -d ".codex/skills" ]]; then
  docker exec "$NAME" sh -lc "mkdir -p \"$CODEX_HOME_DOCKER/skills\""
  docker cp ".codex/skills/." "$NAME:$CODEX_HOME_DOCKER/skills"
fi

docker exec "$NAME" sh -lc "if [ -f \"$DOCKER_PID_FILE\" ]; then PID=\$(cat \"$DOCKER_PID_FILE\" || true); if [ -n \"\$PID\" ]; then kill -0 \"\$PID\" 2>/dev/null && kill \"\$PID\" || true; fi; fi"
sleep 1

docker exec "$NAME" sh -lc "mkdir -p \"$ENGINE_DIR\" && rm -rf \"$ENGINE_DIR/dist\" \"$ENGINE_DIR/schemas\""
docker cp dist "$NAME:$ENGINE_DIR/dist"
docker cp schemas "$NAME:$ENGINE_DIR/schemas"
docker cp package.json package-lock.json "$NAME:$ENGINE_DIR/"
docker cp conversations-in-blockkit.md "$NAME:$ENGINE_DIR/"

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

if ! docker exec "$NAME" sh -lc "test -d \"$ENGINE_DIR/node_modules\""; then
  docker exec "$NAME" sh -lc "cd \"$ENGINE_DIR\" && npm ci --omit=dev"
fi

docker exec "${ENV_ARGS[@]}" "$NAME" sh -lc "cd \"$ENGINE_DIR\" && nohup node \"$ENGINE_DIR/dist/index.js\" --log-level debug -- --yolo > /workspace/alfred.log 2>&1 & echo \$! | tee /workspace/alfred.pid > \"$DOCKER_PID_FILE\""

if [[ -f "$PID_FILE" ]]; then
  cat "$PID_FILE"
fi
