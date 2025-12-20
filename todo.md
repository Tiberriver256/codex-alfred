# End-to-End Implementation TODO

## Foundations
- [ ] Create project layout (src/, tests/, data/, scripts/) and TS config.
- [ ] Add package.json with Node LTS engines, scripts, and `type: module` (if using ESM).
- [ ] Set up `mise` tooling config (already pinned via `.mise.toml`).
- [ ] Add basic lint/format config (minimal, optional).

## Config + CLI
- [ ] Define config/env vars (`SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `ALFRED_WORKDIR`, data path, sandbox options).
- [ ] Implement CLI entrypoint with flags:
  - `--appKey`, `--botKey`, `--data-dir`
  - `--sandbox=host|docker:<name>`
  - `--` passthrough for Codex args
- [ ] Validate config and print actionable errors.

## Data Persistence
- [ ] Implement thread mapping store (JSON file first, SQLite optional).
- [ ] Model: `thread_key`, `codex_thread_id`, `last_response_ts`, `last_seen_user_ts`.
- [ ] Load on startup; persist after each update; handle file creation and corruption.

## Slack Integration (Socket Mode)
- [ ] Set up Bolt `App` with Socket Mode receiver.
- [ ] Fetch bot user ID via `auth.test`.
- [ ] Handle `app_mention` events with immediate `ack()`.
- [ ] Resolve `thread_ts` rules (new thread vs existing).
- [ ] Fetch thread history via `conversations.replies` (new messages since `last_response_ts`).
- [ ] Strip bot mentions from user text; ignore bot messages.

## Codex Integration
- [ ] Initialize `@openai/codex-sdk` client.
- [ ] Create or resume Codex threads per Slack thread mapping.
- [ ] Build prompt from new messages (author + timestamp).
- [ ] Run Codex with Block Kit output schema and working directory.
- [ ] Record usage/latency for logging.

## Block Kit Validation + Posting
- [ ] Load `schemas/blockkit-response.schema.json`.
- [ ] Validate Codex output JSON; on failure, post fallback error Block Kit.
- [ ] Post response to the correct thread (`chat.postMessage`).
- [ ] Update `last_response_ts` and persist.

## Error Handling + Retries
- [ ] Retry Slack API once on failure; log errors with thread key.
- [ ] Guardrails for missing threads or empty histories.
- [ ] Safety for Codex failures/timeouts (fallback message).

## Docker Sandbox (Easy Start)
- [ ] Implement `docker.sh` with `create/start/stop/remove/status/shell`.
- [ ] Validate Docker install and running container on startup.
- [ ] Support `--sandbox=docker:<name>` and mount `/workspace`.
- [ ] Execute Codex in container `--yolo` mode; allow passthrough args.

## Testing
- [ ] Define `node:test` setup for TypeScript (erasable TS or `tsx` loader).
- [ ] Add integration tests for Slack event flow -> Codex -> Block Kit.
- [ ] Add fakes for Slack Web API and Codex SDK adapter.
- [ ] Add schema validation contract tests.

## Docs + Release
- [ ] Update README with Node LTS + mise instructions and test command.
- [ ] Document config flags, env vars, and Docker sandbox flow.
- [ ] Confirm Slack app manifest link flow and scopes.
- [ ] Add release notes and versioning strategy (npm, tags).
