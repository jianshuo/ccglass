import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { createForwardProxy } from "../src/forward-proxy.js";
import { ensureCA } from "../src/ca.js";

// Minimal store mock
class MockStore extends EventEmitter {
  constructor() {
    super();
    this.entries = [];
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-fp-test-"));
    this.sessionDir = path.join(this.root, "test-session");
    fs.mkdirSync(this.sessionDir, { recursive: true });
    this.seq = 0;
  }
  add({ request }) {
    const rec = { id: `test/${++this.seq}`, request, response: null };
    this.entries.push(rec);
    return rec;
  }
  update(rec) {
    this.emit("update", rec);
  }
  cleanup() {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

test("forward-proxy tunnels non-target hosts transparently", async () => {
  // Create a simple TCP echo server to act as "upstream"
  const echo = net.createServer((sock) => {
    sock.on("data", (d) => { sock.write(d); sock.end(); });
  });
  await new Promise((r) => echo.listen(0, "127.0.0.1", r));
  const echoPort = echo.address().port;

  const caDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-fp-ca-"));
  const ca = ensureCA(caDir);
  const store = new MockStore();

  const proxy = createForwardProxy({ store, targets: ["target.example.com"], ca });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const proxyPort = proxy.address().port;

  // Connect through proxy to echo server (non-target, should tunnel directly)
  const result = await new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: proxyPort,
      method: "CONNECT",
      path: `127.0.0.1:${echoPort}`,
    });
    req.on("connect", (res, socket) => {
      assert.strictEqual(res.statusCode, 200);
      socket.write("hello");
      socket.on("data", (d) => {
        resolve(d.toString());
        socket.end();
      });
    });
    req.on("error", reject);
    req.end();
  });

  assert.strictEqual(result, "hello");
  assert.strictEqual(store.entries.length, 0, "non-target should not be captured");

  proxy.close();
  echo.close();
  store.cleanup();
  fs.rmSync(caDir, { recursive: true, force: true });
});

test("decodeChunked strips chunk-size lines", async () => {
  // "data: {\"hello\":\"world\"}\n\n" is 25 bytes = 0x19
  const chunked = "19\r\ndata: {\"hello\":\"world\"}\n\n\r\n0\r\n\r\n";
  const expected = "data: {\"hello\":\"world\"}\n\n";

  function decodeChunked(raw) {
    const out = [];
    let pos = 0;
    while (pos < raw.length) {
      const lineEnd = raw.indexOf("\r\n", pos);
      if (lineEnd < 0) break;
      const sizeLine = raw.slice(pos, lineEnd).trim();
      const size = parseInt(sizeLine, 16);
      if (isNaN(size) || size === 0) break;
      const dataStart = lineEnd + 2;
      const dataEnd = dataStart + size;
      if (dataEnd > raw.length) { out.push(raw.slice(dataStart)); break; }
      out.push(raw.slice(dataStart, dataEnd));
      pos = dataEnd + 2;
    }
    return out.join("");
  }

  const result = decodeChunked(chunked);
  assert.strictEqual(result, expected);
});

test("decodeChunked handles multiple chunks", () => {
  function decodeChunked(raw) {
    const out = [];
    let pos = 0;
    while (pos < raw.length) {
      const lineEnd = raw.indexOf("\r\n", pos);
      if (lineEnd < 0) break;
      const sizeLine = raw.slice(pos, lineEnd).trim();
      const size = parseInt(sizeLine, 16);
      if (isNaN(size) || size === 0) break;
      const dataStart = lineEnd + 2;
      const dataEnd = dataStart + size;
      if (dataEnd > raw.length) { out.push(raw.slice(dataStart)); break; }
      out.push(raw.slice(dataStart, dataEnd));
      pos = dataEnd + 2;
    }
    return out.join("");
  }

  const chunked = "5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
  assert.strictEqual(decodeChunked(chunked), "hello world");
});
