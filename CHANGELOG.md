# Changelog

All notable changes to ccglass are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases
up to and including 1.1.2 predate this file; see the git history for those.

## [Unreleased]

### Added
- `ccglass usage --by-session` now labels each row with the agent's own session name (Claude Code's `/rename` title, else its auto-generated title, else the first prompt), recovered from the Claude Code transcript linked via each request's `metadata.user_id`. The raw timestamp id column is kept alongside so sessions sharing a title stay distinguishable.
- `ccglass usage --by-timestamp` lists sessions by their raw capture-timestamp id (the id `ccglass rm`/`export` take), without resolving names.

### Changed
- Session-name resolution is opt-in: `--by-session` enables it, while default `usage`, `/api/usage`, and the MCP session tools no longer scan `~/.claude/projects`.
