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
  "codex-azure": {
    label: "Codex (Azure OpenAI)",
    command: "codex",
    format: "openai",
    envVar: "AZURE_OPENAI_ENDPOINT",
    upstream: "auto",
    autoUpstream: true,
    note: "Codex Azure: set AZURE_OPENAI_ENDPOINT to your Azure OpenAI endpoint and AZURE_OPENAI_API_KEY to your key.",
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
  glm: {
    label: "GLM / Zhipu AI",
    command: null,
    format: "openai",
    envVar: "OPENAI_BASE_URL",
    upstream: "auto",
    autoUpstream: true,
    note: "GLM/Zhipu uses an OpenAI-compatible API. Set OPENAI_BASE_URL to your Zhipu endpoint (e.g. https://open.bigmodel.cn/api/paas/v4) and OPENAI_API_KEY to your Zhipu key.",
  },
  ollama: {
    label: "Ollama (local)",
    command: null,
    format: "openai",
    envVar: "OPENAI_BASE_URL",
    upstream: "http://127.0.0.1:11434",
    note: "Ollama serves an OpenAI-compatible API on port 11434. Override the address with --upstream if needed.",
  },
  lmstudio: {
    label: "LM Studio (local)",
    command: null,
    format: "openai",
    envVar: "OPENAI_BASE_URL",
    upstream: "http://127.0.0.1:1234",
    note: "LM Studio serves an OpenAI-compatible API on port 1234. Override the address with --upstream if needed.",
  },
  openrouter: {
    label: "OpenRouter",
    command: null,
    format: "openai",
    envVar: "OPENAI_BASE_URL",
    upstream: "https://openrouter.ai/api",
    note: "OpenRouter is OpenAI-compatible. Set OPENAI_API_KEY to your OpenRouter key.",
  },
  bedrock: {
    label: "AWS Bedrock (via Claude Code)",
    command: "claude",
    format: "anthropic",
    envVar: "ANTHROPIC_BASE_URL",
    upstream: "auto",
    autoUpstream: true,
    mcp: true,
    note: "Bedrock: set ANTHROPIC_BASE_URL to your Bedrock endpoint before running (e.g. https://bedrock-runtime.us-east-1.amazonaws.com). AWS credentials are forwarded as-is.",
  },
  vertex: {
    label: "Google Vertex AI (via Claude Code)",
    command: "claude",
    format: "anthropic",
    envVar: "ANTHROPIC_BASE_URL",
    upstream: "auto",
    autoUpstream: true,
    mcp: true,
    note: "Vertex AI: set ANTHROPIC_BASE_URL to your Vertex endpoint before running (e.g. https://us-east5-aiplatform.googleapis.com). GCP credentials are forwarded as-is.",
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
