import { test } from "node:test";
import assert from "node:assert/strict";
import { getAdapter } from "../src/formats/index.js";
import { normUsageReasonix } from "../src/formats/reasonix.js";

test("getAdapter resolves reasonix format", () => {
  assert.equal(getAdapter("reasonix").name, "reasonix");
});

test("normUsageReasonix maps DeepSeek cache fields", () => {
  const u = normUsageReasonix({
    prompt_tokens: 1000,
    completion_tokens: 50,
    prompt_cache_hit_tokens: 900,
    prompt_cache_miss_tokens: 100,
  });
  assert.equal(u.input_tokens, 1000);
  assert.equal(u.output_tokens, 50);
  assert.equal(u.cache_read_input_tokens, 900);
});

test("reasonix.cost uses DeepSeek v4-flash pricing", () => {
  const A = getAdapter("reasonix");
  const c = A.cost("deepseek-v4-flash", {
    prompt_tokens: 1_000_000,
    completion_tokens: 0,
    prompt_cache_hit_tokens: 1_000_000,
    prompt_cache_miss_tokens: 0,
  });
  assert.ok(Math.abs(c.usd - 0.0028) < 1e-6);
  assert.equal(c.cacheHitRate, 1);
});

test("reasonix.reassemble applies DeepSeek usage on streamed chat", () => {
  const A = getAdapter("reasonix");
  const sse = [
    `data: {"model":"deepseek-v4-flash","choices":[{"delta":{"content":"ok"}}]}`,
    `data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":20}}`,
    `data: [DONE]`,
  ].join("\n");
  const r = A.reassemble(sse);
  assert.equal(r.usage.cache_read_input_tokens, 80);
  assert.equal(r.usage.input_tokens, 100);
});
