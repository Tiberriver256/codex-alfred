# End-to-End Implementation TODO

## Foundations
- [x] Create project layout (src/, tests/, data/, scripts/) and TS config.
- [x] Add package.json with Node LTS engines, scripts, and `type: module` (if using ESM).
- [x] Set up `mise` tooling config (already pinned via `.mise.toml`).
- [ ] Add basic lint/format config (minimal, optional).

## Config + CLI
- [x] Define config/env vars (`SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `ALFRED_WORKDIR`, data path, sandbox options).
- [x] Implement CLI entrypoint with flags:
  - `--appKey`, `--botKey`, `--data-dir`
  - `--sandbox=host|docker:<name>`
  - `--` passthrough for Codex args
- [x] Validate config and print actionable errors.

## Data Persistence
- [x] Implement thread mapping store (JSON file first, SQLite optional).
- [x] Model: `thread_key`, `codex_thread_id`, `last_response_ts`, `last_seen_user_ts`.
- [x] Load on startup; persist after each update; handle file creation and corruption.

## Slack Integration (Socket Mode)
- [x] Set up Bolt `App` with Socket Mode receiver.
- [x] Fetch bot user ID via `auth.test`.
- [x] Handle `app_mention` events with immediate `ack()`.
- [x] Resolve `thread_ts` rules (new thread vs existing).
- [x] Fetch thread history via `conversations.replies` (new messages since `last_response_ts`).
- [x] Strip bot mentions from user text; ignore bot messages.

## Codex Integration
- [x] Initialize `@openai/codex-sdk` client.
- [x] Create or resume Codex threads per Slack thread mapping.
- [x] Build prompt from new messages (author + timestamp).
- [x] Run Codex with Block Kit output schema and working directory.
- [x] Record usage/latency for logging.

## Block Kit Validation + Posting
- [x] Load `schemas/blockkit-response.schema.json`.
- [x] Validate Codex output JSON; on failure, post fallback error Block Kit.
- [x] Post response to the correct thread (`chat.postMessage`).
- [x] Update `last_response_ts` and persist.

## Error Handling + Retries
- [x] Retry Slack API once on failure; log errors with thread key.
- [x] Guardrails for missing threads or empty histories.
- [x] Safety for Codex failures/timeouts (fallback message).

## Docker Sandbox (Easy Start)
- [x] Implement `docker.sh` with `create/start/stop/remove/status/shell`.
- [x] Validate Docker install and running container on startup.
- [x] Support `--sandbox=docker:<name>` and mount `/workspace`.
- [x] Execute Codex in container `--yolo` mode; allow passthrough args.

## Testing
- [x] Define `node:test` setup for TypeScript (erasable TS or `tsx` loader).
- [x] Add integration tests for Slack event flow -> Codex -> Block Kit.
- [x] Add fakes for Slack Web API and Codex SDK adapter.
- [x] Add schema validation contract tests.

## Docs + Release
- [x] Update README with Node LTS + mise instructions and test command.
- [x] Document config flags, env vars, and Docker sandbox flow.
- [x] Confirm Slack app manifest link flow and scopes.
- [x] Add release notes and versioning strategy (npm, tags).
