import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  hostOnly,
  buildAllowedHosts,
  hostGuardMiddleware,
  resolveAllowedHostsFromEnv,
} from "../src/host-guard.js";
import { createServer } from "../src/server.js";
import { createProxy } from "../src/proxy.js";

test("hostOnly strips port and lowercases plain hostnames", () => {
  assert.equal(hostOnly("127.0.0.1:1234"), "127.0.0.1");
  assert.equal(hostOnly("Localhost:42"), "localhost");
  assert.equal(hostOnly("attacker.example"), "attacker.example");
  assert.equal(hostOnly("EVIL.com"), "evil.com");
});

test("hostOnly handles bracketed IPv6 with and without ports", () => {
  assert.equal(hostOnly("[::1]:8080"), "::1");
  assert.equal(hostOnly("[::1]"), "::1");
  assert.equal(hostOnly("[2001:db8::1]:80"), "2001:db8::1");
});

test("hostOnly rejects unbracketed bare IPv6 (malformed Host)", () => {
  assert.equal(hostOnly("::1"), "");
  assert.equal(hostOnly("2001:db8::1"), "");
});

test("hostOnly returns empty for missing or wrong-type Host", () => {
  assert.equal(hostOnly(""), "");
  assert.equal(hostOnly(undefined), "");
  assert.equal(hostOnly(null), "");
  assert.equal(hostOnly(42), "");
});

test("buildAllowedHosts always includes loopback names", () => {
  const set = buildAllowedHosts({});
  assert.equal(set.has("127.0.0.1"), true);
  assert.equal(set.has("localhost"), true);
  assert.equal(set.has("::1"), true);
});

test("buildAllowedHosts skips wildcard bind hosts", () => {
  const set = buildAllowedHosts({ bindHost: "0.0.0.0" });
  assert.equal(set.has("0.0.0.0"), false);
  const set2 = buildAllowedHosts({ bindHost: "::" });
  assert.equal(set2.has("::"), false);
});

test("buildAllowedHosts adds a concrete bind host", () => {
  const set = buildAllowedHosts({ bindHost: "ccglass.lan" });
  assert.equal(set.has("ccglass.lan"), true);
});

test("buildAllowedHosts parses a comma-separated env allowlist", () => {
  const set = buildAllowedHosts({ allowedHostsEnv: "ccglass.lan, dev-box, " });
  assert.equal(set.has("ccglass.lan"), true);
  assert.equal(set.has("dev-box"), true);
});

test("resolveAllowedHostsFromEnv reads CCGLASS_ALLOWED_HOSTS", () => {
  assert.equal(resolveAllowedHostsFromEnv({ CCGLASS_ALLOWED_HOSTS: "a,b" }), "a,b");
  assert.equal(resolveAllowedHostsFromEnv({}), "");
  assert.equal(resolveAllowedHostsFromEnv(undefined), "");
});

function rawGet(port, hostHeader, path = "/api/sessions") {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers: { Host: hostHeader } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function withServer(server, fn) {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", async () => {
      const { port } = server.address();
      try {
        await fn(port);
        server.close(() => resolve());
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

test("dashboard rejects DNS-rebinding Host headers with 403", async () => {
  const server = createServer({ roots: [], store: null });
  await withServer(server, async (port) => {
    const ok = await rawGet(port, `127.0.0.1:${port}`);
    assert.equal(ok.status, 200);

    const rebind = await rawGet(port, "attacker.example");
    assert.equal(rebind.status, 403);

    const rebindWithPort = await rawGet(port, `evil.com:${port}`);
    assert.equal(rebindWithPort.status, 403);

    const localhost = await rawGet(port, `localhost:${port}`);
    assert.equal(localhost.status, 200);

    const ipv6 = await rawGet(port, `[::1]:${port}`);
    assert.equal(ipv6.status, 200);
  });
});

test("dashboard honors an env-allowlisted extra Host", async () => {
  const allowedHosts = buildAllowedHosts({ allowedHostsEnv: "tunnel.example" });
  const server = createServer({ roots: [], store: null, allowedHosts });
  await withServer(server, async (port) => {
    const ok = await rawGet(port, "tunnel.example");
    assert.equal(ok.status, 200);
    const bad = await rawGet(port, "other.example");
    assert.equal(bad.status, 403);
  });
});

test("dashboard rejects a Host header with no parseable hostname", async () => {
  // Send raw bytes over a socket so we can omit the Host line entirely. The
  // guard treats an undefined/empty Host as "no parseable hostname" and 403s
  // — same behavior the hostOnly() unit tests prove for "".
  const net = await import("node:net");
  const server = createServer({ roots: [], store: null });
  await withServer(server, async (port) => {
    const reply = await new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
        sock.write("GET /api/sessions HTTP/1.1\r\nConnection: close\r\n\r\n");
      });
      let buf = "";
      sock.on("data", (c) => (buf += c.toString()));
      sock.on("end", () => resolve(buf));
      sock.on("error", reject);
    });
    // HTTP/1.1 servers are entitled to 400 a request with no Host line. Either
    // 400 (rejected at parse time) or 403 (rejected by the guard) is acceptable
    // — what we don't want is a 200 leaking captured data.
    const status = parseInt(reply.split(" ")[1], 10);
    assert.ok(status === 400 || status === 403, `expected 400 or 403, got ${status}`);
  });
});

test("proxy rejects DNS-rebinding Host headers with 403 before forwarding upstream", async () => {
  const fakeStore = { add: () => ({}), update: () => {}, on: () => {} };
  // Upstream points at an unroutable address; a 403 from the guard proves the
  // guard fired BEFORE any forward attempt — otherwise we'd see a 502 or ECONNREFUSED.
  const proxy = createProxy({
    upstream: "http://127.0.0.1:1/",
    store: fakeStore,
  });
  await withServer(proxy, async (port) => {
    const rebind = await rawGet(port, "attacker.example", "/v1/messages");
    assert.equal(rebind.status, 403);
  });
});
