# Scheduled Tasks for Alfred (PRD)

## Summary
Add scheduled tasks so a user can configure Alfred to post a new thread in a chosen Slack channel at a specific time of day and frequency, with a provided instruction. The posted message should tag Alfred and start a fresh thread in that channel.

## Problem
Today Alfred only reacts when explicitly mentioned. Users want recurring, time-based prompts that reliably kick off a new Alfred thread in the right channel without manual mentions.

## Goals
- Provide a simple UI to create and save a schedule with: time of day, frequency, instruction, and Slack channel.
- At the scheduled time, create a new root message in the selected channel that mentions Alfred and includes the instruction.
- Persist schedules across restarts and show basic status (next run time, enabled/disabled).

## Non-goals (v1)
- Complex cron expressions or multi-step workflows.
- Multi-timezone scheduling per task (one timezone per task, inferred from creator).
- Scheduling that depends on external data sources or calendar integrations.
- Full analytics or admin dashboards.

## Success metrics
- >= 90% of scheduled runs post within 2 minutes of the intended time.
- < 1% duplicate scheduled posts.
- Users can create a schedule in under 60 seconds.

## User stories
- As a user, I can schedule a daily Alfred reminder in #ops at 9:00 to summarize yesterday's deploys.
- As a user, I can schedule a weekly prompt every Monday at 10:00 in #product to draft the weekly plan.
- As a user, I can pause or delete a schedule if it is no longer needed.

## UX flow
Entry point (pick one for MVP):
- Slash command: `/alfred-schedule` opens a modal.
- Or App Home with a "Create schedule" button that opens the same modal.

Modal fields:
- Time of day (HH:MM local time). Use a simple text input with validation, or a datetime picker and extract the time portion.
- Frequency: daily, weekdays, weekly (choose day), or monthly (optional for v1).
- Instruction (multi-line input).
- Channel (Slack conversations select).
- Save button (submit).

After submit:
- Persist the schedule.
- Confirm to the user (ephemeral confirmation or App Home refresh).
- Display the schedule list (optional v1) with next run and enable/disable controls.

## Functional requirements

### 1) Scheduling UI
- Use Slack modals opened via `views.open` with a `trigger_id`.
- Input blocks for time, frequency, instruction, and channel.
- Use a conversations select element for channel selection, filtered to channels only.
- Validate input on submit (time format, frequency selection, instruction non-empty).

### 2) Data model and persistence
Create a new schedules store similar to `ThreadStore`:
- File: `data/schedules.json`
- Versioned payload with a map keyed by schedule ID.

Proposed Schedule record:
- `id`: string (uuid)
- `createdAt`: ISO string
- `createdBy`: Slack user id
- `channelId`: string
- `instruction`: string
- `frequency`: enum (`daily`, `weekdays`, `weekly`, `monthly`)
- `dayOfWeek`: number (0-6) for weekly
- `timeOfDay`: "HH:MM"
- `timezone`: IANA tz (from user profile)
- `enabled`: boolean
- `lastRunAt`: ISO string | null
- `nextRunAt`: ISO string

### 3) Scheduler engine
- On startup: load schedules, compute `nextRunAt` if missing or in the past.
- Run a timer loop (every 30-60s) to find due schedules.
- For each due schedule:
  - Mark as running in memory to avoid duplicates.
  - Post the scheduled message (see below).
  - Update `lastRunAt` and compute `nextRunAt`.
  - Persist changes.
- If posting fails, retry once and log; do not advance `nextRunAt` on failure.

### 4) Scheduled message posting
- Use `chat.postMessage` to post a root message (no `thread_ts`).
- Message text should include a user mention for Alfred: `<@ALFRED_BOT_USER_ID>` and the instruction.
- Example text: "<@U123ABC> Scheduled task: {instruction}".
- Optionally include Block Kit blocks for readability (header + section + context).

### 5) Integrating with existing Alfred flow
- Do not rely on `app_mention` events from bot-authored messages.
- After posting, either:
  - Call the existing Codex handler directly with a synthetic "mention" payload, or
  - Add a new internal path that creates a Codex thread from the instruction and posts the response in the new thread.
- Ensure thread mapping (`thread_key` -> `codex_thread_id`) is created for scheduled posts.

### 6) Permissions and Slack limits
- Ensure `chat:write` (and `chat:write.public` if posting to channels where Alfred is not a member).
- For channel selection, `conversations_select` uses the user's visible conversations; filter to public/private channels.
- Respect `chat.postMessage` rate limits (approx 1 msg/sec per channel).

## Slack platform research notes (key constraints)
- `chat.postMessage` posts to channels, DMs, or MPIMs; omitting `thread_ts` creates a new root message, while providing `thread_ts` posts a reply in a thread.
- User mentions in message text use the `mrkdwn` syntax `<@USERID>`.
- Modals are opened with `views.open` and require a `trigger_id`. Input blocks require a `submit` field in the modal view.
- The `conversations_select` element can be used in modals to choose from visible channels.
- A `datetimepicker` element exists for date/time input; if it is too heavy for a simple time-of-day, use plain text input with validation.

## Edge cases
- Bot not in the selected channel (handle Slack API error and notify creator).
- Timezone drift (user changes timezone after creating schedule).
- App restarts with overdue schedules (decide whether to run immediately or skip to next occurrence).
- Duplicate runs if multiple instances are started (assume single instance for v1).

## Open questions
- Which entry point is preferred: slash command, global shortcut, or App Home button?
- Should schedules be shared globally or per-user only?
- Should Alfred post the instruction only, or also run Codex and respond immediately in the new thread?
- Do we need weekday and weekly schedules in v1, or start with daily only?

## Rollout
- Phase 1: internal alpha with a single schedule per user.
- Phase 2: add list/edit/disable UI in App Home.
- Phase 3: add more frequencies and audit logging.
