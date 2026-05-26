import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createProxy } from "../src/proxy.js";
import { Store, summarize } from "../src/store.js";
import { latencyMs } from "../src/session-stats.js";

test("proxy records startedAt and finishedAt for latency", async () => {
  let upstream;
  const upstreamReady = new Promise((resolve) => {
    upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        setTimeout(() => {
          res.write(JSON.stringify({ ok: true }));
          res.end();
        }, 40);
      });
    });
    upstream.listen(0, "127.0.0.1", () => resolve(upstream.address()));
  });
  const upAddr = await upstreamReady;
  const upUrl = `http://127.0.0.1:${upAddr.port}`;

  const store = new Store({
    root: fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-proxy-")),
    format: "openai",
  });
  const proxy = createProxy({ upstream: upUrl, store });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = proxy.address().port;

  const done = new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: proxyPort,
        path: "/v1/test",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", resolve);
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ model: "x" }));
  });
  await done;

  const rec = store.entries[0];
  assert.ok(rec.startedAt, "startedAt set when upstream request begins");
  assert.ok(rec.response?.finishedAt, "finishedAt set when response completes");
  assert.ok(rec.response?.firstByteAt, "firstByteAt set on first upstream chunk");
  assert.ok(rec.startedAt >= rec.ts);
  assert.ok(rec.response.firstByteAt >= rec.startedAt);
  assert.ok(rec.response.finishedAt >= rec.response.firstByteAt);

  const ms = latencyMs(rec);
  assert.ok(ms >= 35, `expected at least upstream delay, got ${ms}ms`);

  const sum = summarize(rec);
  assert.equal(sum.latencyMs, ms);

  proxy.close();
  upstream.close();
});
