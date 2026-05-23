# ccglass

**See exactly what your coding agent sends to the model.** A zero-dependency
local logging reverse-proxy + web dashboard for **Claude Code, Codex,
DeepSeek-TUI, and Kimi**.
One command, like `ollama`:

```bash
npm install -g ccglass
ccglass
```

Run with no arguments and `ccglass` asks which client to inspect:

```
  Which client do you want to inspect?

    1) Claude Code
    2) Codex (OpenAI)
    3) DeepSeek-TUI
    4) Kimi (Moonshot, via Claude Code)

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
| `run --provider <p> -- <cmd>` | any client | per provider | per provider | per provider |

Kimi runs through Claude Code against Moonshot's Anthropic-compatible endpoint —
make sure your Moonshot key is set (`ANTHROPIC_AUTH_TOKEN`).
DeepSeek-TUI uses its OpenAI-compatible Chat Completions endpoint — make sure
your DeepSeek key is set (`DEEPSEEK_API_KEY`).

## What you get

- **Live request stream** — every call appears instantly; click to expand the
  system prompt, messages, and tools with all escaped strings unescaped.
- **Turn-to-turn diff** — pick two requests, see exactly what context was added
  this turn and which blocks carry a cache breakpoint.
- **Token / cache / cost** — exact input/output/cache tokens from the response
  `usage`, cache-hit rate, and estimated USD per request (per-provider pricing).
- **Response reassembly + export** — streamed SSE rebuilt into the final message
  (`stop_reason`, tool calls, usage), for both the Anthropic and OpenAI wire
  formats; export any request to Markdown / JSON / HAR.

## Usage

```bash
ccglass                       # pick a client interactively
ccglass claude [args...]      # inspect Claude Code (args pass through, e.g. --resume)
ccglass codex  [args...]      # inspect Codex
ccglass deepseek [args...]    # inspect DeepSeek-TUI (dispatcher)
ccglass deepseek-tui [args...] # inspect DeepSeek-TUI runtime directly
ccglass kimi   [args...]      # inspect Kimi (via Claude Code)
ccglass run --provider openai -- <cmd...>   # inspect any client
ccglass view                  # re-open the dashboard over saved .ccglass/ logs
ccglass export <id> --format md|json|har
```

### Options

| Flag | Default | Meaning |
|---|---|---|
| `--provider <p>` | from command | Force format/env for `run` (`claude`/`codex`/`kimi`/`openai`) |
| `--upstream <url>` | per provider | Override the upstream API |
| `--port <n>` | auto | Dashboard port |
| `--proxy-port <n>` | auto | Proxy port |
| `--dir <path>` | `./.ccglass` | Where logs are stored |
| `--open` | off | Open the dashboard in your browser |
| `--no-redact` | off | Keep auth tokens unmasked in saved logs |

## Logs & secrets

Captures are written to `./.ccglass/<session>/NNNN.json`. Auth tokens
(`authorization`, `x-api-key`) are **masked by default** — pass `--no-redact`
to keep them. Treat the log directory as sensitive regardless.

## Requirements

Node ≥ 18. No runtime dependencies.

## License

MIT
