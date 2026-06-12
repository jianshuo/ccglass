import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { summarizeUsage } from "../src/usage.js";

function mkRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ccglass-usage-${label}-`));
}

// Build an Anthropic-style non-streaming response body with a known usage block,
// then return it as `raw` JSON the way the proxy persists it. Reassembly via the
// anthropic adapter reads usage from the parsed JSON.
function anthropicResp({ input_tokens = 0, output_tokens = 0, cache_creation_input_tokens = 0, cache_read_input_tokens = 0 } = {}) {
  return JSON.stringify({
    type: "message",
    role: "assistant",
    content: [],
    stop_reason: "end_turn",
    usage: { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens },
  });
}

function record(store, model, usage) {
  const rec = store.add({
    request: { method: "POST", url: "/v1/messages", headers: {}, body: { model, messages: [], tools: [] } },
  });
  rec.response = { status: 200, raw: anthropicResp(usage) };
  store.update(rec);
  return rec;
}

// OpenAI Responses-API non-streaming body. `cached_tokens` lives under
// `input_tokens_details` and is included in `input_tokens` (gross), unlike
// Anthropic where cache_read is reported separately from `input_tokens'.
function openaiResp({ input_tokens = 0, output_tokens = 0, cached_tokens = 0 } = {}) {
  return JSON.stringify({
    object: "response",
    model: "gpt-5",
    status: "completed",
    output: [],
    usage: {
      input_tokens,
      output_tokens,
      input_tokens_details: { cached_tokens },
    },
  });
}

function recordOpenAI(store, model, usage) {
  const rec = store.add({
    request: { method: "POST", url: "/v1/responses", headers: {}, body: { model, input: [], tools: [] } },
  });
  rec.response = { status: 200, raw: openaiResp(usage) };
  store.update(rec);
  return rec;
}

test("summarizeUsage aggregates totals, byModel, bySession across roots", () => {
  const root = mkRoot("agg");
  const s1 = new Store({ root, format: "anthropic" });
  record(s1, "claude-opus-4-7", { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900 });
  record(s1, "claude-sonnet-4-6", { input_tokens: 200, output_tokens: 80 });

  // Make a second session by writing through a fresh Store (its sessionId is its ctor timestamp,
  // which monotonically advances).
  const s2 = new Store({ root, format: "anthropic" });
  record(s2, "claude-opus-4-7", { input_tokens: 50, output_tokens: 25, cache_read_input_tokens: 0 });

  const out = summarizeUsage([root]);

  assert.equal(out.sessionCount, 2);
  assert.equal(out.requestCount, 3);
  assert.equal(out.unmeasured, 0);

  // totals
  assert.equal(out.totals.input, 100 + 200 + 50);          // 350
  assert.equal(out.totals.output, 50 + 80 + 25);           // 155
  assert.equal(out.totals.cacheRead, 900);
  assert.equal(out.totals.cacheWrite, 0);
  assert.equal(out.totals.totalInput, 350 + 900);          // 1250
  assert.ok(Math.abs(out.totals.cacheHitRate - 900 / 1250) < 1e-9);
  assert.ok(out.totals.usd > 0);

  // byModel sorted by spend desc; opus should be more expensive per-call than sonnet
  // even at half the input tokens, so it stays first.
  const models = out.byModel.map((m) => m.model);
  assert.equal(models[0], "claude-opus-4-7");
  assert.ok(out.byModel.find((m) => m.model === "claude-sonnet-4-6").requests === 1);
  assert.equal(out.byModel.find((m) => m.model === "claude-opus-4-7").requests, 2);

  // bySession has both sessions, each with its own totals. Order is
  // newest-first (inherits listSessionsMulti) so callers like list_sessions
  // don't have to re-sort — the second Store was constructed after the first
  // so its session id is greater and must sort first.
  assert.equal(out.bySession.length, 2);
  assert.ok(out.bySession[0].session > out.bySession[1].session,
    `expected newest-first; got ${out.bySession.map((s) => s.session).join(", ")}`);
  for (const session of out.bySession) {
    assert.ok(session.session);
    assert.ok(session.entries >= 1);
    assert.ok(session.usd > 0);
  }

  // Name resolution is opt-in: the default rollup never scans transcripts, so
  // every session's name stays null (the shape stays stable for JSON consumers).
  for (const session of out.bySession) assert.equal(session.name, null);

  fs.rmSync(root, { recursive: true, force: true });
});

test("summarizeUsage counts records without usage as unmeasured", () => {
  const root = mkRoot("unmeasured");
  const store = new Store({ root, format: "anthropic" });

  // A pending request (no response yet) — must be counted in `unmeasured`, not totals.
  store.add({
    request: { method: "POST", url: "/v1/messages", headers: {}, body: { model: "claude-opus-4-7", messages: [], tools: [] } },
  });

  // A real request with usage — must be counted in totals.
  record(store, "claude-opus-4-7", { input_tokens: 10, output_tokens: 5 });

  const out = summarizeUsage([root]);
  assert.equal(out.requestCount, 1);
  assert.equal(out.unmeasured, 1);
  assert.equal(out.totals.input, 10);
  assert.equal(out.totals.output, 5);

  fs.rmSync(root, { recursive: true, force: true });
});

test("summarizeUsage returns empty rollup when no sessions exist", () => {
  const root = mkRoot("empty");
  const out = summarizeUsage([root]);
  assert.equal(out.sessionCount, 0);
  assert.equal(out.requestCount, 0);
  assert.equal(out.unmeasured, 0);
  assert.equal(out.totals.usd, 0);
  assert.deepEqual(out.byModel, []);
  assert.deepEqual(out.bySession, []);
  assert.equal(out.range.from, null);
  assert.equal(out.range.to, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("summarizeUsage does not double-count OpenAI cached input", () => {
  // OpenAI/Codex contract: `input_tokens` is gross (cached + uncached).
  // Aggregator must trust each adapter's `totalInput`, not recompute it as
  // input + cacheRead + cacheWrite (which would double-count for OpenAI).
  const root = mkRoot("openai-cached");
  const store = new Store({ root, format: "openai" });
  recordOpenAI(store, "gpt-5", { input_tokens: 1000, output_tokens: 100, cached_tokens: 800 });

  const out = summarizeUsage([root]);
  assert.equal(out.requestCount, 1);
  assert.equal(out.totals.cacheRead, 800);
  assert.equal(
    out.totals.totalInput,
    1000,
    `OpenAI input_tokens is already gross; expected totalInput=1000, got ${out.totals.totalInput}`,
  );
  assert.ok(
    Math.abs(out.totals.cacheHitRate - 0.8) < 1e-9,
    `expected 80% hit rate; got ${out.totals.cacheHitRate}`,
  );

  fs.rmSync(root, { recursive: true, force: true });
});

test("summarizeUsage buckets by the reassembled response model, not the request body", () => {
  // Bedrock / gateway-proxied shape: the request body carries no model, but the
  // streamed response does. The rollup must key off the response so traffic does
  // not collapse into "unknown" and get priced at the Sonnet default tier.
  const root = mkRoot("resp-model");
  const store = new Store({ root, format: "anthropic" });
  const rec = store.add({
    request: { method: "POST", url: "/v1/messages", headers: {}, body: { messages: [], tools: [] } },
  });
  rec.response = {
    status: 200,
    raw: JSON.stringify({
      type: "message",
      model: "claude-opus-4-5",
      stop_reason: "end_turn",
      content: [],
      usage: { input_tokens: 100, output_tokens: 50 },
    }),
  };
  store.update(rec);

  const out = summarizeUsage([root]);
  assert.equal(out.byModel.length, 1);
  assert.equal(out.byModel[0].model, "claude-opus-4-5");
  // Priced at the Opus tier, not the Sonnet default that "unknown" would fall to.
  const sonnetDefault = (100 * 3 + 50 * 15) / 1e6;
  assert.ok(
    out.byModel[0].usd > sonnetDefault,
    `expected Opus-tier pricing > Sonnet default ${sonnetDefault}; got ${out.byModel[0].usd}`,
  );

  fs.rmSync(root, { recursive: true, force: true });
});

test("summarizeUsage groups unknown model under 'unknown'", () => {
  const root = mkRoot("unknown-model");
  const store = new Store({ root, format: "anthropic" });
  // Request body without `model`: aggregator must still count it, bucketed as "unknown".
  const rec = store.add({
    request: { method: "POST", url: "/v1/messages", headers: {}, body: { messages: [], tools: [] } },
  });
  rec.response = { status: 200, raw: anthropicResp({ input_tokens: 7, output_tokens: 3 }) };
  store.update(rec);

  const out = summarizeUsage([root]);
  assert.equal(out.byModel.length, 1);
  assert.equal(out.byModel[0].model, "unknown");
  assert.equal(out.byModel[0].requests, 1);

  fs.rmSync(root, { recursive: true, force: true });
});
