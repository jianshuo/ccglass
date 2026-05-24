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
    mcp: true, // Claude Code accepts --mcp-config: auto-inject ccglass's inspection tools
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
    mcp: true, // runs the `claude` binary, so --mcp-config works here too
  },
  openai: {
    label: "OpenAI (generic)",
    command: null,
    format: "openai",
    envVar: "OPENAI_BASE_URL",
    upstream: "https://api.openai.com",
  },
  opencode: {
    label: "OpenCode",
    command: "opencode",
    format: "openai",
    envVar: "OPENAI_BASE_URL",
    upstream: "auto",       // resolved from current env at run time
    autoUpstream: true,
    noSettings: true,       // OpenCode doesn't use --settings flag like Claude Code
  },
};

export const PICKABLE = ["claude", "codex", "deepseek", "kimi", "opencode"]; // shown in the no-arg picker

// Resolve a provider from a CLI token (e.g. "claude"), falling back to a custom
// command wrapped under an explicit --provider.
export function resolveProvider(name, providerOverride, envVarOverride) {
  const base = providerOverride && PROVIDERS[providerOverride]
    ? { ...PROVIDERS[providerOverride] }
    : PROVIDERS[name]
      ? { ...PROVIDERS[name] }
      : { label: name, command: name, format: "anthropic", envVar: "ANTHROPIC_BASE_URL", upstream: "https://api.anthropic.com" };
  if (providerOverride && PROVIDERS[providerOverride] && name) base.command = name;
  if (envVarOverride) base.envVar = envVarOverride;
  return base;
}
