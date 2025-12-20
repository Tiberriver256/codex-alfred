# codex-alfred spec

## Overview
codex-alfred is a lightweight Slack butler that bridges Slack Socket Mode events to the Codex CLI via the Codex TypeScript SDK. Every Slack thread maps 1:1 to a Codex thread, and every response is delivered as Block Kit JSON using a strict output schema.

## Goals
- Use Slack Socket Mode (websockets) for near-instant messaging, no web server.
- Tie each Slack thread to exactly one Codex thread ID.
- Only send messages in the thread that happened since the bot's last response.
- Require Codex output to be valid Block Kit JSON via structured output schema.
- Keep the wiring thin: Slack <-> Codex SDK, no agent framework or extra tools.
- Provide an easy-start Docker sandbox mode with a persistent data directory for secure agent execution.

## Non-goals
- Implement pi-mono or Claude-specific toolchains.
- Build a full scheduling/event system.
- Support every Block Kit surface (modals, home tabs) in v1.

## Inputs and Outputs
- Inputs: Slack events via Socket Mode (`app_mention`), plus on-demand thread history via Web API.
- Outputs: Slack messages posted in the same thread, using Block Kit only.

## Dependencies
- `@slack/bolt` for Socket Mode + Slack Web API.
- `@openai/codex-sdk` for Codex CLI integration.

## Slack App Setup (minimum)
Enable Socket Mode and create:
- App-level token: `connections:write` (xapp-...)
- Bot token scopes:
  - `app_mentions:read`
  - `channels:history`, `channels:read`
  - `groups:history`, `groups:read`
  - `im:history`, `im:read`
  - `mpim:history`, `mpim:read`
  - `chat:write`
  - `users:read`

Subscribe to events:
- `app_mention`

Note: `app_mention` is the only trigger. All other thread messages are pulled on-demand using `conversations.replies` when a mention occurs.

## Data Model
Persisted state (simple JSON file or SQLite):
- `thread_key`: `${channel_id}:${thread_ts}`
- `codex_thread_id`: string
- `last_response_ts`: Slack timestamp of the last bot response in this thread
- `last_seen_user_ts`: last user message ts included in a Codex turn (optional)

Recommended file: `data/threads.json` for v1.

## Thread Mapping Rules
1. First mention in a channel (no `thread_ts`):
   - Create Slack thread using the root message `ts` as `thread_ts`.
   - Create a new Codex thread with `codex.startThread()`.
   - Store mapping `{channel_id}:{thread_ts} -> codex_thread_id`.
2. Mention inside a thread (`thread_ts` present):
   - Look up mapping and resume the same Codex thread.
   - If no mapping exists, create one (treat as a new Codex thread).

## Event Flow
### On startup
- Read env/config.
- Instantiate Bolt `App` with a Socket Mode receiver.
- Load persisted mappings into memory.
- Fetch bot user ID with `auth.test`.

### On `app_mention`
1. `ack()` immediately.
2. Determine `thread_ts`:
   - If `event.thread_ts` exists, use it.
   - Else use `event.ts` (start a new Slack thread under the mention).
3. Resolve Codex thread:
   - Resume if `thread_key` exists.
   - Else create new thread and store mapping.
4. Fetch new messages since last response:
   - Call `conversations.replies({ channel, ts: thread_ts, oldest: last_response_ts })`.
   - Filter out bot messages (`subtype = bot_message` or `user == bot_user_id`).
   - Keep only messages strictly newer than `last_response_ts`.
5. Build prompt for Codex:
   - Compact list of messages with author + timestamp.
   - Strip `<@bot_id>` mentions from message text.
6. Run Codex turn with output schema:
   - `thread.run(prompt, { outputSchema: blockkitSchema })`.
7. Parse/validate response JSON, post in thread:
   - `chat.postMessage({ channel, thread_ts, text, blocks })`.
8. Update `last_response_ts` and persist state.

## Prompt Format (v1)
```
Thread: C123ABC / 1700000000.000001
Messages since last response:
- [1700000000.000001] @alice: <text>
- [1700000005.000002] @bob: <text>

Respond in Block Kit JSON according to the output schema.
```

## Codex SDK Integration
- Use `@openai/codex-sdk` and `codex.startThread()`.
- Set thread options:
  - `workingDirectory`: configured path (env `ALFRED_WORKDIR`).
  - `skipGitRepoCheck`: true by default to avoid blocking.
  - `approvalPolicy`: `never`.
- For Docker easy-start, run Codex in `--yolo` mode (SDK equivalent) and pass through extra CLI args.
- Use `outputSchema` each turn for Block Kit JSON.

## Block Kit Output Schema (v1)
We enforce a complete Block Kit message schema covering all message block types,
block elements, and composition objects as documented by Slack and reflected in
the `blockkit` library.

Core constraints derived from Slack docs and blockkit library:
- Max 50 blocks per message.
- Text object type is `plain_text` or `mrkdwn` (with length limits per object).
- All interactive elements require `action_id`.

Schema file: `schemas/blockkit-response.schema.json`.

### Example output
```
{
  "text": "Build succeeded; next steps listed.",
  "blocks": [
    {"type": "header", "text": {"type": "plain_text", "text": "Build Update"}},
    {"type": "section", "text": {"type": "mrkdwn", "text": "*Status:* OK\n*Next:* run tests"}},
    {"type": "divider"},
    {"type": "context", "elements": [
      {"type": "mrkdwn", "text": "Requested by @alice"}
    ]}
  ]
}
```

## Error Handling
- If Codex returns invalid JSON or fails schema validation, post a fallback Block Kit message:
  - Header: "Alfred error"
  - Section: short error summary
- If Slack API fails, log error with thread key and retry once.

## Logging and Observability
- Log structured events: `thread_key`, `codex_thread_id`, `event_ts`, latency.
- Include Codex usage (token counts) in logs (not posted to Slack).

## Security
- Tokens loaded from env (`SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`).
- No secrets written to logs.
- Local state file stored under `data/` (gitignored).

## Docker Sandbox Easy Start
Goal: secure tool execution by running Codex inside a Docker container with a persistent data directory.

Requirements:
- Provide an easy-start path (helper script or CLI mode) that creates/starts a named container and runs codex-alfred against it.
- The host data directory is mounted to `/workspace` in the container and is also the Codex working directory.
- The data directory is user-configurable (default to current working dir) to keep setups reusable.
- Start Codex inside the container in `--yolo` mode by default.
- Allow additional Codex CLI args to be passed through (e.g., after `--`).

## Open Questions
- Should DMs be treated as a single thread or mirrored to per-message threads?
- Should we backfill context on startup or only on mention?
- Do we want separate schemas for modals and Home tabs?
