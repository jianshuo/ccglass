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
