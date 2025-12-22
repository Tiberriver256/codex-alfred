# codex-alfred

Slack "butler" that bridges Slack threads to Codex CLI via the Codex TypeScript SDK.

## Easy install (create your own Slack app)
Each user creates their own Slack app and gets their own tokens. Use the manifest link below to open Slack's app creation flow:

<!-- slack-manifest-link:start -->

[![Create Slack App](https://img.shields.io/badge/Slack-Create%20App-4A154B?logo=slack&logoColor=white)](https://api.slack.com/apps?new_app=1&manifest_yaml=display_information%3A%0A%20%20name%3A%20codex-alfred%0A%20%20description%3A%20Slack%20butler%20that%20bridges%20threads%20to%20Codex%20CLI.%0A%20%20background_color%3A%20%22%234A154B%22%0Afeatures%3A%0A%20%20bot_user%3A%0A%20%20%20%20display_name%3A%20Alfred%0A%20%20%20%20always_online%3A%20false%0Aoauth_config%3A%0A%20%20scopes%3A%0A%20%20%20%20bot%3A%0A%20%20%20%20%20%20-%20app_mentions%3Aread%0A%20%20%20%20%20%20-%20channels%3Ahistory%0A%20%20%20%20%20%20-%20channels%3Aread%0A%20%20%20%20%20%20-%20groups%3Ahistory%0A%20%20%20%20%20%20-%20groups%3Aread%0A%20%20%20%20%20%20-%20im%3Ahistory%0A%20%20%20%20%20%20-%20im%3Aread%0A%20%20%20%20%20%20-%20mpim%3Ahistory%0A%20%20%20%20%20%20-%20mpim%3Aread%0A%20%20%20%20%20%20-%20chat%3Awrite%0A%20%20%20%20%20%20-%20users%3Aread%0Asettings%3A%0A%20%20socket_mode_enabled%3A%20true%0A%20%20event_subscriptions%3A%0A%20%20%20%20bot_events%3A%0A%20%20%20%20%20%20-%20app_mention%0A%20%20interactivity%3A%0A%20%20%20%20is_enabled%3A%20false%0A%20%20org_deploy_enabled%3A%20false)

<!-- slack-manifest-link:end -->

### End-to-end setup
1. Click the button above, create the app in your workspace, then install it. Copy:
   - App-level token (`xapp-...`)
   - Bot token (`xoxb-...`)
2. Install prerequisites:
   - Docker
   - Node.js LTS (pinned via mise)
     - `mise install`
3. Run Alfred locally:
```
npx @tiberriver256/codex-alfred --appKey <app-key> --botKey <bot-key> --data-dir ./data
```
4. In Slack, mention `@Alfred` in a channel or DM to get started.

See `spec.md` for the product/technical spec.

## Local restart (dev)
Use the npm script to restart Alfred with the same command we’ve been using. It prints the new PID.
```
ALFRED_PID=<old-pid> npm run alfred:restart
```
Notes:
- Uses `ALFRED_DATA_DIR` if set; otherwise defaults to `~/mom-data`.
- Writes logs to `$ALFRED_DATA_DIR/alfred.log`.
- If you don’t pass `ALFRED_PID`, it just starts a new process.

## Configuration
You can supply tokens via CLI flags or environment variables:
- `--appKey` or `SLACK_APP_TOKEN`
- `--botKey` or `SLACK_BOT_TOKEN`
- `--data-dir` or `ALFRED_DATA_DIR`
- `--workdir` or `ALFRED_WORKDIR`
- `--sandbox` or `ALFRED_SANDBOX` (`host` or `docker:<name>`)
- `--log-level` or `ALFRED_LOG_LEVEL`

Pass additional Codex CLI args after `--`:
```
codex-alfred --appKey ... --botKey ... -- --yolo
```

## Testing
```
node --test --import=tsx
```

## Docker sandbox
Use the helper script to create and manage the sandbox container:
```
./docker.sh create ./data
./docker.sh start
```
When running with `--sandbox docker:<name>`, Alfred adds `--yolo` to Codex args by default (unless you pass it explicitly).

To restart Alfred using the Docker sandbox in one step:
```
./alfred-docker.sh
```
Notes:
- Builds the repo and syncs `dist/`, `schemas/`, and `conversations-in-blockkit.md` into the data dir.
- Runs Alfred **inside** the Docker container and writes logs to `/workspace/alfred.log`.
- Kills any host `codex-alfred` processes by default (set `ALFRED_STOP_HOST=0` to skip).
