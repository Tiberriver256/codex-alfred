# Tech Stack

Modern, minimalist stack optimized for a thin Slack <-> Codex bridge.

## Runtime + Language
- Node.js LTS (Active) for CLI runtime (currently v24), pinned via mise
- TypeScript (source)

## Slack Integration
- Slack Socket Mode via `@slack/bolt`
- Block Kit messages validated against `schemas/blockkit-response.openai.schema.json`
- App manifest flow for self-serve app creation (`slack-app-manifest.yaml`)

## Codex Integration
- `@openai/codex-sdk` for thread management + structured output
- Output schema enforcement for Block Kit JSON

## Data + Storage
- Simple local persistence (JSON file or SQLite per spec)
- Workspace data directory mounted as `/workspace` in Docker mode

## Container/Sandbox
- Optional Docker sandbox for tool execution
- Alpine-based container, stateful by default

## CI/Automation
- GitHub Actions
- README manifest link check on push to `main` and manifest changes

## Testing
Strategy: avoid mocks. Favor integration tests and fakes.
- Runner: `node:test` (minimal, no extra deps)
- TypeScript: Node 24 can execute `.ts` tests with built-in type stripping (erasable TS only; `node --test` matches `.ts` patterns unless `--no-strip-types` is used). For non-erasable TS or `tsconfig` features, use a loader like `tsx` (e.g., `node --test --import=tsx`) or compile TS -> JS before tests.
- Integration focus: exercise Slack event flow -> Codex thread -> Block Kit response
- Fakes instead of mocks:
  - Local HTTP fake for Slack Web API (requests/responses at the boundary)
  - Stub Codex SDK adapter that returns deterministic responses
- Contract tests for schema validity (Block Kit JSON schema)
