#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${ALFRED_DATA_DIR:-$HOME/mom-data}"
CODEX_HOME_HOST="${CODEX_HOME:-$HOME/.codex}"
CODEX_HOME_DOCKER="/codex-home"
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
docker exec "$NAME" sh -lc "if [ -d /workspace/skills/slack-docs-browser ]; then mkdir -p \"$CODEX_HOME_DOCKER/skills\"; rm -rf \"$CODEX_HOME_DOCKER/skills/slack-docs-browser\"; cp -R /workspace/skills/slack-docs-browser \"$CODEX_HOME_DOCKER/skills/\"; fi"

docker exec "$NAME" sh -lc "if [ -f \"$DOCKER_PID_FILE\" ]; then PID=\$(cat \"$DOCKER_PID_FILE\" || true); if [ -n \"\$PID\" ]; then kill -0 \"\$PID\" 2>/dev/null && kill \"\$PID\" || true; fi; fi"
sleep 1

if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete dist/ "$DATA_DIR/dist/"
  rsync -a --delete schemas/ "$DATA_DIR/schemas/"
  rsync -a package.json package-lock.json "$DATA_DIR/"
else
  rm -rf "$DATA_DIR/dist" "$DATA_DIR/schemas"
  cp -R dist "$DATA_DIR/dist"
  cp -R schemas "$DATA_DIR/schemas"
  cp package.json package-lock.json "$DATA_DIR/"
fi

cp conversations-in-blockkit.md "$DATA_DIR/conversations-in-blockkit.md"

ENV_ARGS=()
for var in SLACK_APP_TOKEN SLACK_BOT_TOKEN ALFRED_LOG_LEVEL OPENAI_API_KEY CODEX_HOME; do
  if [[ -n "${!var:-}" ]]; then
    ENV_ARGS+=("-e" "${var}=${!var}")
  fi
done

ENV_ARGS+=("-e" "ALFRED_DATA_DIR=/workspace")
ENV_ARGS+=("-e" "CODEX_HOME=$CODEX_HOME_DOCKER")
ENV_ARGS+=("-e" "ALFRED_SANDBOX=host")
ENV_ARGS+=("-e" "ALFRED_WORKDIR=/workspace")

if ! docker exec "$NAME" sh -lc "test -d /workspace/node_modules"; then
  docker exec "$NAME" sh -lc "cd /workspace && npm ci --omit=dev"
fi

docker exec "${ENV_ARGS[@]}" "$NAME" sh -lc "cd /workspace && nohup node /workspace/dist/index.js --log-level debug -- --yolo > /workspace/alfred.log 2>&1 & echo \$! | tee /workspace/alfred.pid > \"$DOCKER_PID_FILE\""

if [[ -f "$PID_FILE" ]]; then
  cat "$PID_FILE"
fi
