import { test } from "node:test";
import assert from "node:assert/strict";
import { PICKABLE, resolveProvider } from "../src/providers.js";

test("deepseek provider wraps DeepSeek-TUI with OpenAI-compatible capture", () => {
  const provider = resolveProvider("deepseek");

  assert.equal(provider.label, "DeepSeek-TUI");
  assert.equal(provider.command, "deepseek");
  assert.equal(provider.format, "openai");
  assert.equal(provider.envVar, "DEEPSEEK_BASE_URL");
  assert.equal(provider.upstream, "https://api.deepseek.com");
});

test("deepseek-tui alias wraps the runtime binary directly", () => {
  const provider = resolveProvider("deepseek-tui");

  assert.equal(provider.label, "DeepSeek-TUI");
  assert.equal(provider.command, "deepseek-tui");
  assert.equal(provider.format, "openai");
  assert.equal(provider.envVar, "DEEPSEEK_BASE_URL");
});

test("deepseek can be used as a run provider override", () => {
  const provider = resolveProvider("custom-agent", "deepseek");

  assert.equal(provider.command, "custom-agent");
  assert.equal(provider.format, "openai");
  assert.equal(provider.envVar, "DEEPSEEK_BASE_URL");
});

test("deepseek is available in the interactive picker", () => {
  assert.ok(PICKABLE.includes("deepseek"));
});

test("ollama preset uses OPENAI_BASE_URL and a fixed local upstream", () => {
  const provider = resolveProvider("ollama");

  assert.equal(provider.label, "Ollama (local)");
  assert.equal(provider.format, "openai");
  assert.equal(provider.envVar, "OPENAI_BASE_URL");
  assert.equal(provider.upstream, "http://127.0.0.1:11434");
});

test("lmstudio preset uses OPENAI_BASE_URL and a fixed local upstream", () => {
  const provider = resolveProvider("lmstudio");

  assert.equal(provider.label, "LM Studio (local)");
  assert.equal(provider.format, "openai");
  assert.equal(provider.envVar, "OPENAI_BASE_URL");
  assert.equal(provider.upstream, "http://127.0.0.1:1234");
});

test("openrouter preset uses OPENAI_BASE_URL and the OpenRouter base upstream", () => {
  const provider = resolveProvider("openrouter");

  assert.equal(provider.label, "OpenRouter");
  assert.equal(provider.format, "openai");
  assert.equal(provider.envVar, "OPENAI_BASE_URL");
  assert.equal(provider.upstream, "https://openrouter.ai/api");
});

test("glm preset uses OPENAI_BASE_URL with autoUpstream", () => {
  const provider = resolveProvider("glm");

  assert.equal(provider.label, "GLM / Zhipu AI");
  assert.equal(provider.format, "openai");
  assert.equal(provider.envVar, "OPENAI_BASE_URL");
  assert.equal(provider.autoUpstream, true);
});

test("bedrock preset uses ANTHROPIC_BEDROCK_BASE_URL with autoUpstream", () => {
  // Claude Code in Bedrock mode reads its endpoint from
  // ANTHROPIC_BEDROCK_BASE_URL — ANTHROPIC_BASE_URL is silently ignored, so
  // injecting the wrong key lets requests bypass the proxy entirely.
  const provider = resolveProvider("bedrock");

  assert.equal(provider.label, "AWS Bedrock (via Claude Code)");
  assert.equal(provider.format, "anthropic");
  assert.equal(provider.envVar, "ANTHROPIC_BEDROCK_BASE_URL");
  assert.equal(provider.command, "claude");
  assert.equal(provider.autoUpstream, true);
});

test("vertex preset uses ANTHROPIC_BASE_URL with autoUpstream", () => {
  const provider = resolveProvider("vertex");

  assert.equal(provider.label, "Google Vertex AI (via Claude Code)");
  assert.equal(provider.format, "anthropic");
  assert.equal(provider.envVar, "ANTHROPIC_BASE_URL");
  assert.equal(provider.command, "claude");
  assert.equal(provider.autoUpstream, true);
});

test("ollama can be used as a run provider override", () => {
  const provider = resolveProvider("custom-agent", "ollama");

  assert.equal(provider.command, "custom-agent");
  assert.equal(provider.format, "openai");
  assert.equal(provider.envVar, "OPENAI_BASE_URL");
  assert.equal(provider.upstream, "http://127.0.0.1:11434");
});

test("openrouter can be used as a run provider override", () => {
  const provider = resolveProvider("my-tool", "openrouter");

  assert.equal(provider.command, "my-tool");
  assert.equal(provider.format, "openai");
  assert.equal(provider.envVar, "OPENAI_BASE_URL");
  assert.equal(provider.upstream, "https://openrouter.ai/api");
});

test("opencode provider uses OPENAI_BASE_URL with autoUpstream", () => {
  const provider = resolveProvider("opencode");

  assert.equal(provider.label, "OpenCode");
  assert.equal(provider.command, "opencode");
  assert.equal(provider.format, "openai");
  assert.equal(provider.envVar, "OPENAI_BASE_URL");
  assert.equal(provider.upstream, "auto");
  assert.equal(provider.autoUpstream, true);
});

test("opencode is available in the interactive picker", () => {
  assert.ok(PICKABLE.includes("opencode"));
});

test("codex-azure provider uses AZURE_OPENAI_ENDPOINT with autoUpstream", () => {
  const provider = resolveProvider("codex-azure");

  assert.equal(provider.label, "Codex (Azure OpenAI)");
  assert.equal(provider.command, "codex");
  assert.equal(provider.format, "openai");
  assert.equal(provider.envVar, "AZURE_OPENAI_ENDPOINT");
  assert.equal(provider.autoUpstream, true);
});

test("codex-azure can be used as a run provider override", () => {
  const provider = resolveProvider("custom-agent", "codex-azure");

  assert.equal(provider.command, "custom-agent");
  assert.equal(provider.format, "openai");
  assert.equal(provider.envVar, "AZURE_OPENAI_ENDPOINT");
  assert.equal(provider.autoUpstream, true);
});
