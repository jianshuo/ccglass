import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Store } from "../src/store.js";
import { createServer } from "../src/server.js";

function mkRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ccglass-server-${label}-`));
}

function anthropicResp({ input_tokens = 0, output_tokens = 0, cache_read_input_tokens = 0 } = {}) {
  return JSON.stringify({
    type: "message",
    role: "assistant",
    content: [],
    stop_reason: "end_turn",
    usage: { input_tokens, output_tokens, cache_creation_input_tokens: 0, cache_read_input_tokens },
  });
}

function record(store, model, usage) {
  const rec = store.add({
    request: { method: "POST", url: "/v1/messages", headers: {}, body: { model, messages: [], tools: [] } },
  });
  rec.response = { status: 200, raw: anthropicResp(usage) };
  store.update(rec);
}

async function withServer(roots, fn) {
  const server = createServer({ roots, store: null });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try { await fn(port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: p }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

test("GET /api/usage returns the aggregator payload", async () => {
  const root = mkRoot("usage-route");
  const store = new Store({ root, format: "anthropic" });
  record(store, "claude-opus-4-7", { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200 });
  record(store, "claude-sonnet-4-6", { input_tokens: 40, output_tokens: 10 });

  await withServer([root], async (port) => {
    const res = await get(port, "/api/usage");
    assert.equal(res.status, 200);
    const u = JSON.parse(res.body);
    assert.equal(u.sessionCount, 1);
    assert.equal(u.requestCount, 2);
    assert.equal(u.totals.input, 140);
    assert.equal(u.totals.output, 60);
    assert.equal(u.totals.cacheRead, 200);
    assert.ok(u.totals.usd > 0);
    assert.equal(u.byModel.length, 2);
    assert.equal(u.bySession.length, 1);
  });

  fs.rmSync(root, { recursive: true, force: true });
});

test("GET /api/usage returns empty rollup when no sessions exist", async () => {
  const root = mkRoot("usage-empty");
  await withServer([root], async (port) => {
    const res = await get(port, "/api/usage");
    assert.equal(res.status, 200);
    const u = JSON.parse(res.body);
    assert.equal(u.sessionCount, 0);
    assert.equal(u.requestCount, 0);
    assert.deepEqual(u.byModel, []);
    assert.deepEqual(u.bySession, []);
  });
  fs.rmSync(root, { recursive: true, force: true });
});
