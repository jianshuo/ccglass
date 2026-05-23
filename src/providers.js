// Supported clients. Each provider knows which env var points its CLI at the
// proxy, the default upstream to forward to, the response format, and the
// actual binary to spawn.

export const PROVIDERS = {
  claude: {
    label: "Claude Code",
    command: "claude",
    format: "anthropic",
    envVar: "ANTHROPIC_BASE_URL",
    upstream: "https://api.anthropic.com",
  },
  codex: {
    label: "Codex (OpenAI)",
    command: "codex",
    format: "openai",
    envVar: "OPENAI_BASE_URL",
    upstream: "https://api.openai.com",
  },
  deepseek: {
    label: "DeepSeek-TUI",
    command: "deepseek",
    format: "openai",
    envVar: "DEEPSEEK_BASE_URL",
    upstream: "https://api.deepseek.com",
    note: "DeepSeek-TUI uses OpenAI-compatible Chat Completions. Make sure your DeepSeek key is set (DEEPSEEK_API_KEY).",
  },
  "deepseek-tui": {
    label: "DeepSeek-TUI",
    command: "deepseek-tui",
    format: "openai",
    envVar: "DEEPSEEK_BASE_URL",
    upstream: "https://api.deepseek.com",
    note: "DeepSeek-TUI uses OpenAI-compatible Chat Completions. Make sure your DeepSeek key is set (DEEPSEEK_API_KEY).",
  },
  kimi: {
    label: "Kimi (Moonshot, via Claude Code)",
    command: "claude",
    format: "anthropic",
    envVar: "ANTHROPIC_BASE_URL",
    upstream: "https://api.moonshot.ai/anthropic",
    note: "Kimi runs through Claude Code. Make sure your Moonshot key is set (ANTHROPIC_AUTH_TOKEN).",
  },
  openai: {
    label: "OpenAI (generic)",
    command: null,
    format: "openai",
    envVar: "OPENAI_BASE_URL",
    upstream: "https://api.openai.com",
  },
};

export const PICKABLE = ["claude", "codex", "deepseek", "kimi"]; // shown in the no-arg picker

// Resolve a provider from a CLI token (e.g. "claude"), falling back to a custom
// command wrapped under an explicit --provider.
export function resolveProvider(name, providerOverride) {
  if (providerOverride && PROVIDERS[providerOverride]) {
    const p = { ...PROVIDERS[providerOverride] };
    if (name) p.command = name;
    return p;
  }
  if (PROVIDERS[name]) return { ...PROVIDERS[name] };
  // Unknown command: default to anthropic env (most CLIs people wrap are Claude-like).
  return { label: name, command: name, format: "anthropic", envVar: "ANTHROPIC_BASE_URL", upstream: "https://api.anthropic.com" };
}
