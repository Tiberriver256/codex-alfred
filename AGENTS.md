# AGENTS

- Create skills inside `.codex/skills` in this repo (not in `~/.codex/skills`).
- Avoid throwing errors where the system would already throw errors. You inadvertently hide the stack and make troubleshooting harder when you do that.
- When a user mentions a problem during their exploratory testing you need to: 1. Document the desired behavior in the form of a failing test 2. Make the test go green
