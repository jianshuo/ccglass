# ccglass

**See exactly what your coding agent sends to the model.** A lightweight
local logging reverse-proxy + web dashboard for **Claude Code, Codex,
OpenCode, DeepSeek-TUI, Kimi, Ollama, OpenRouter, and more**.
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

## Providers

| `ccglass <provider>` or `--provider` | Wraps | Env var | Upstream | Format |
|---|---|---|---|---|
| `claude` | Claude Code | `ANTHROPIC_BASE_URL` | api.anthropic.com | Anthropic Messages |
| `codex` | Codex | `OPENAI_BASE_URL` | api.openai.com | OpenAI Responses / Chat |
| `deepseek` | DeepSeek-TUI dispatcher | `DEEPSEEK_BASE_URL` | api.deepseek.com | OpenAI Chat |
| `deepseek-tui` | DeepSeek-TUI runtime | `DEEPSEEK_BASE_URL` | api.deepseek.com | OpenAI Chat |
| `kimi` | Claude Code → Moonshot | `ANTHROPIC_BASE_URL` | api.moonshot.ai/anthropic | Anthropic Messages |
| `opencode` | OpenCode | `OPENAI_BASE_URL` | auto (from env) | OpenAI Chat |
| `ollama` | any Ollama-backed client | `OPENAI_BASE_URL` | 127.0.0.1:11434 | OpenAI Chat |
| `lmstudio` | any LM Studio-backed client | `OPENAI_BASE_URL` | 127.0.0.1:1234 | OpenAI Chat |
| `openrouter` | any OpenRouter-backed client | `OPENAI_BASE_URL` | openrouter.ai/api | OpenAI Chat |
| `glm` | any GLM/Zhipu-backed client | `OPENAI_BASE_URL` | auto (from env) | OpenAI Chat |
| `bedrock` | Claude Code → AWS Bedrock | `ANTHROPIC_BASE_URL` | auto (from env) | Anthropic Messages |
| `vertex` | Claude Code → Google Vertex AI | `ANTHROPIC_BASE_URL` | auto (from env) | Anthropic Messages |
| `run --provider <p> -- <cmd>` | any client | per provider | per provider | per provider |

**Notes by provider:**

- **Codex** — captures traffic when Codex is in **API-key mode** (`OPENAI_API_KEY`). If Codex is authenticated via **ChatGPT login**, it uses a WebSocket transport (`wss://chatgpt.com/...`) that bypasses `OPENAI_BASE_URL` — the dashboard will be empty. Run `codex doctor` to check your auth mode; if it shows `auth mode: chatgpt`, switch to API-key mode to use ccglass.
- **Kimi** — runs through Claude Code against Moonshot's Anthropic-compatible endpoint; set `ANTHROPIC_AUTH_TOKEN` to your Moonshot key.
- **DeepSeek-TUI** — OpenAI-compatible Chat Completions; set `DEEPSEEK_API_KEY`.
- **OpenCode** — auto-detects upstream from `OPENAI_BASE_URL`; set it before running. Use `--env-var` if your OpenCode provider uses a different env var name.
- **Ollama / LM Studio** — no key needed for local models; pass `--upstream` if your server runs on a non-default address.
- **OpenRouter** — set `OPENAI_API_KEY` to your OpenRouter key.
- **GLM/Zhipu** — set `OPENAI_BASE_URL` to your Zhipu endpoint (e.g. `https://open.bigmodel.cn/api/paas/v4`) and `OPENAI_API_KEY` to your Zhipu key.
- **AWS Bedrock** — set `ANTHROPIC_BASE_URL` to your Bedrock runtime endpoint (e.g. `https://bedrock-runtime.us-east-1.amazonaws.com`) before running; AWS credentials are forwarded as-is from your environment.
- **Google Vertex AI** — set `ANTHROPIC_BASE_URL` to your Vertex AI endpoint (e.g. `https://us-east5-aiplatform.googleapis.com`) before running; GCP credentials are forwarded as-is.

### Custom provider recipe

Any tool that reads a base-URL env var can be inspected with the generic escape hatch:

```bash
# OpenAI-compatible tool with a custom endpoint
ccglass run \
  --upstream https://my.custom.api/v1 \
  --env-var MY_CUSTOM_BASE_URL \
  -- my-tool [args...]

# Shorthand alias
ccglass run --base-url https://my.custom.api/v1 --env-var MY_BASE_URL -- my-tool

# Reuse an existing provider's format but point at a different upstream
ccglass run --provider openai --upstream https://my.openai-compat.api -- my-tool
```

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
