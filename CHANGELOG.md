# Changelog

All notable changes to ccglass are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases
up to and including 1.1.2 predate this file; see the git history for those.

## [Unreleased]

### Added
- `ccglass usage --by-session` now labels each row with the agent's own session name (Claude Code's `/rename` title, else its auto-generated title, else the first prompt), recovered from the Claude Code transcript linked via each request's `metadata.user_id`. The raw timestamp id column is kept alongside so sessions sharing a title stay distinguishable.
- `ccglass usage --by-timestamp` lists sessions by their raw capture-timestamp id (the id `ccglass rm`/`export` take), without resolving names.
- The web dashboard's Summary → "by session" table now shows the resolved session name alongside the timestamp id, matching `ccglass usage --by-session`. A new "by timestamp" sub-tab lists sessions by their raw capture-timestamp id only, matching `ccglass usage --by-timestamp`.

### Changed
- Session-name resolution is opt-in and lazy: the CLI's `--by-session` enables it, and the web dashboard requests names (`/api/usage?names=1`) only for its by-session tab — the by-model and by-timestamp tabs, default `usage`, and the MCP session tools never scan `~/.claude/projects`. A short-lived shared cache keeps the dashboard's live-session reloads from re-scanning on every refresh.
