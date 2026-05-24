# ccglass

**See exactly what your coding agent sends to the model.** A lightweight
local logging reverse-proxy + web dashboard for **Claude Code, Codex,
OpenCode, DeepSeek-TUI, and Kimi**.
One command, like `ollama`:

```bash
npm install -g ccglass
ccglass
```

<p align="center">
  <img src="https://raw.githubusercontent.com/jianshuo/ccglass/main/docs/demo.gif" alt="ccglass dashboard — live request capture, token/cache/cost, message history with tool calls, the agent-loop flow view, and a turn-to-turn diff" width="100%">
</p>

Run with no arguments and `ccglass` asks which client to inspect:

```
  Which client do you want to inspect?

    1) Claude Code
    2) Codex (OpenAI)
    3) DeepSeek-TUI
    4) Kimi (Moonshot, via Claude Code)
    5) OpenCode

  >
```

Or name it directly: `ccglass claude`, `ccglass codex`, `ccglass deepseek`,
`ccglass deepseek-tui`, or `ccglass kimi`.

`ccglass` starts a proxy, points the client at it via the right base-URL env var,
launches it for you, and opens a dashboard where you watch every request in real
time — the full system prompt, every tool schema, the message history,
token/cache/cost numbers, and a turn-to-turn diff.

```
  ● ccglass watching Codex (OpenAI) → https://api.openai.com
    dashboard: http://127.0.0.1:57633
```

## Why

These CLIs are Node/native apps that **ignore `HTTP_PROXY`/`HTTPS_PROXY`** — so
Charles/mitmproxy never see the traffic, and `fetch`-patching tools break across
updates. `ccglass` sidesteps all of it: the client does the HTTPS to the real API
itself; you only intercept the plain HTTP hop to localhost. No CA certs, no TLS
pinning.

## Supported clients

| `ccglass <client>` | Wraps | Env var | Upstream | Format |
|---|---|---|---|---|
| `claude` | Claude Code | `ANTHROPIC_BASE_URL` | api.anthropic.com | Anthropic Messages |
| `codex` | Codex | `OPENAI_BASE_URL` | api.openai.com | OpenAI Responses / Chat |
| `deepseek` | DeepSeek-TUI dispatcher | `DEEPSEEK_BASE_URL` | api.deepseek.com | OpenAI Chat |
| `deepseek-tui` | DeepSeek-TUI runtime | `DEEPSEEK_BASE_URL` | api.deepseek.com | OpenAI Chat |
| `kimi` | Claude Code → Moonshot | `ANTHROPIC_BASE_URL` | api.moonshot.ai/anthropic | Anthropic Messages |
| `opencode` | OpenCode | `OPENAI_BASE_URL` | auto (from env) | OpenAI Chat |
| `run --provider <p> -- <cmd>` | any client | per provider | per provider | per provider |

Kimi runs through Claude Code against Moonshot's Anthropic-compatible endpoint —
make sure your Moonshot key is set (`ANTHROPIC_AUTH_TOKEN`).
DeepSeek-TUI uses its OpenAI-compatible Chat Completions endpoint — make sure
your DeepSeek key is set (`DEEPSEEK_API_KEY`).

OpenCode auto-detects the upstream from the `OPENAI_BASE_URL` environment
variable, so you don't need `--upstream` — just make sure it's set before
running `ccglass opencode`. Use `--env-var` to override the environment
variable name if your OpenCode provider uses a custom one.

## What you get

- **Live request stream** — every call appears instantly; click to expand the
  system prompt, messages, and tools with all escaped strings unescaped. Long
  blocks fold behind a show/hide toggle; each row shows its timestamp and a
  tool-call count.
- **Conversation flow** — a top-to-bottom sequence diagram of the agent loop:
  which tool the model picked from the menu, how it ran locally, and how the
  result was fed back. `tool_use` and `tool_result` are paired by `call_id` and
  color-coded; skill calls are flagged.
- **Turn-to-turn diff** — pick two requests, see exactly what context was added
  this turn and which blocks carry a cache breakpoint.
- **Token / cache / cost** — exact input/output/cache tokens from the response
  `usage`, cache-hit rate, and estimated USD per request (per-provider pricing).
- **Response reassembly + export** — streamed SSE rebuilt into the final message
  (`stop_reason`, tool calls, usage), for both the Anthropic and OpenAI wire
  formats; export any request to a readable **raw** HTTP transcript, Markdown,
  JSON, or HAR.
- **Self-inspection (MCP)** — when wrapping Claude Code, ccglass registers its
  own query tools so the agent can inspect the very requests it just made, right
  inside the chat (`--no-mcp` to skip).

## Usage

```bash
ccglass                       # pick a client interactively
ccglass claude [args...]      # inspect Claude Code (args pass through, e.g. --resume)
ccglass codex  [args...]      # inspect Codex
ccglass deepseek [args...]    # inspect DeepSeek-TUI (dispatcher)
ccglass deepseek-tui [args...] # inspect DeepSeek-TUI runtime directly
ccglass kimi   [args...]      # inspect Kimi (via Claude Code)
ccglass opencode [args...]    # inspect OpenCode (auto-detects upstream from OPENAI_BASE_URL)
ccglass run --provider openai -- <cmd...>   # inspect any client
ccglass view                  # re-open the dashboard over saved .ccglass/ logs
ccglass export <id> --format raw|md|json|har   # raw = readable HTTP transcript
```

### Options

| Flag | Default | Meaning |
|---|---|---|
| `--provider <p>` | from command | Force format/env for `run` (`claude`/`codex`/`deepseek`/`kimi`/`openai`) |
| `--upstream <url>` | per provider | Override the upstream API |
| `--port <n>` | auto | Dashboard port |
| `--proxy-port <n>` | auto | Proxy port |
| `--dir <path>` | `./.ccglass` | Where logs are stored |
| `--no-open` | off | The dashboard opens in your browser by default; pass this to skip it |
| `--no-mcp` | off | Don't inject ccglass's self-inspection tools into Claude Code |
| `--no-settings-override` | off | Don't force Claude Code onto the proxy via `--settings` (for when a provider switcher set `ANTHROPIC_BASE_URL`) |
| `--no-redact` | off | Keep auth tokens unmasked in saved logs |
| `--env-var <name>` | per provider | Override the environment variable used to set the proxy URL |

## Logs & secrets

Captures are written to `./.ccglass/<session>/NNNN.json`. Auth tokens
(`authorization`, `x-api-key`) are **masked by default** — pass `--no-redact`
to keep them. Treat the log directory as sensitive regardless.

## Requirements

Node ≥ 18. The core proxy + dashboard have no runtime dependencies; the
optional MCP self-inspection feature (`ccglass claude`) pulls in
`@modelcontextprotocol/sdk` and `zod`.

## Issues

Open an [issue](https://github.com/jianshuo/ccglass/issues/new) and Claude picks
it up automatically — it investigates against the code, and if it's a real,
well-scoped bug or small feature, opens a fix PR that references your issue. Keep
iterating by commenting `@claude` on the issue or the PR. Claude only ever opens
PRs for review; a maintainer merges and releases.

## Acknowledgments

Heartfelt thanks to **庄表伟 ([@zhuangbiaowei](https://github.com/zhuangbiaowei))** for
contributing **first-class DeepSeek-TUI support** ([#1](https://github.com/jianshuo/ccglass/pull/1)).

DeepSeek-TUI ships as a dual-binary coding agent — a `deepseek` dispatcher and a
`deepseek-tui` runtime. 庄表伟 wired up both as native ccglass providers, pointing
them at the proxy via `DEEPSEEK_BASE_URL` and reusing the existing
OpenAI-compatible Chat Completions adapter, so every DeepSeek request now shows up
in the dashboard with zero extra setup. The contribution also added them to the
interactive picker, documented usage across the README, and shipped provider
regression tests to keep it working. Thank you for making ccglass better for the
whole DeepSeek community. 🙏

## Star History

<a href="https://www.star-history.com/?repos=jianshuo%2Fccglass&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=jianshuo/ccglass&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=jianshuo/ccglass&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=jianshuo/ccglass&type=date&legend=top-left" />
 </picture>
</a>

## License

MIT
