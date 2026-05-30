import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, costFromUsage } from "../src/tokens.js";

// Per-1M output rate implied by a pure-output request, used to assert which
// Haiku price tier a model id resolves to.
function outputRate(model) {
  return costFromUsage(model, { output_tokens: 1_000_000 }).usd;
}

test("estimateTokens grows with length and counts CJK heavier", () => {
  assert.ok(estimateTokens("hello world") > 0);
  assert.ok(estimateTokens("你好世界") >= estimateTokens("hihi"));
});

test("costFromUsage computes cost and cache hit rate", () => {
  const c = costFromUsage("claude-opus-4-7", {
    input_tokens: 1000,
    output_tokens: 500,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 9000,
  });
  assert.equal(c.totalInput, 10000);
  assert.ok(Math.abs(c.cacheHitRate - 0.9) < 1e-9);
  assert.ok(c.usd > 0);
});

test("priceFor splits Haiku by generation", () => {
  // Output rates: Haiku 3 = $1.25, Haiku 3.5 = $4, Haiku 4.5 = $5 per MTok.
  assert.ok(Math.abs(outputRate("claude-3-haiku-20240307") - 1.25) < 1e-9);
  assert.ok(Math.abs(outputRate("claude-3-5-haiku-20241022") - 4) < 1e-9);
  assert.ok(Math.abs(outputRate("claude-haiku-4-5-20251001") - 5) < 1e-9);
  // Bedrock-style id prefixes resolve the same way.
  assert.ok(Math.abs(outputRate("anthropic.claude-3-haiku-20240307-v1:0") - 1.25) < 1e-9);
  // A bare / unknown Haiku defaults to the current (4.x) tier.
  assert.ok(Math.abs(outputRate("claude-haiku") - 5) < 1e-9);
});

test("priceFor splits Opus by the 4.5 price cut", () => {
  // Opus 4.5+ output is $25/MTok; Opus 3 / 4 / 4.1 stay at the legacy $75.
  assert.ok(Math.abs(outputRate("claude-opus-4-5-20251101") - 25) < 1e-9);
  assert.ok(Math.abs(outputRate("claude-opus-4-7") - 25) < 1e-9); // 4.6+ kept the cut
  assert.ok(Math.abs(outputRate("claude-opus-4-1-20250805") - 75) < 1e-9);
  assert.ok(Math.abs(outputRate("claude-opus-4-20250514") - 75) < 1e-9); // Opus 4.0
  assert.ok(Math.abs(outputRate("claude-3-opus-20240229") - 75) < 1e-9);
  // Bedrock-style id prefixes resolve the same way.
  assert.ok(Math.abs(outputRate("anthropic.claude-opus-4-5-20251101-v1:0") - 25) < 1e-9);
});
