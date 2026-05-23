// Reverse proxy: Claude Code talks plain HTTP to this server (via
// ANTHROPIC_BASE_URL), we capture the full request + streamed response and
// forward to the real Anthropic API over HTTPS. No TLS interception needed.

import http from "node:http";
import https from "node:https";

export function createProxy({ upstream, store }) {
  const up = new URL(upstream);
  const client = up.protocol === "http:" ? http : https;

  return http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const bodyBuf = Buffer.concat(chunks);
      let body;
      try {
        body = JSON.parse(bodyBuf.toString("utf8"));
      } catch {
        body = bodyBuf.length ? bodyBuf.toString("utf8") : null;
      }

      const rec = store.add({
        request: {
          method: req.method,
          url: req.url,
          headers: { ...req.headers },
          body,
        },
      });

      // Forward upstream. Strip accept-encoding so the captured response is
      // plain text (no gzip/br to decode) — Claude Code handles uncompressed fine.
      const headers = { ...req.headers, host: up.host };
      delete headers["accept-encoding"];

      const proxyReq = client.request(
        {
          protocol: up.protocol,
          hostname: up.hostname,
          port: up.port || (up.protocol === "http:" ? 80 : 443),
          path: (up.pathname === "/" ? "" : up.pathname) + req.url,
          method: req.method,
          headers,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          const respChunks = [];
          proxyRes.on("data", (c) => {
            respChunks.push(c);
            res.write(c);
          });
          proxyRes.on("end", () => {
            res.end();
            rec.response = {
              status: proxyRes.statusCode,
              headers: proxyRes.headers,
              raw: Buffer.concat(respChunks).toString("utf8"),
              finishedAt: Date.now(),
            };
            store.update(rec);
          });
        }
      );

      proxyReq.on("error", (e) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end(`ccglass: upstream error: ${e.message}`);
        rec.response = { error: e.message, finishedAt: Date.now() };
        store.update(rec);
      });

      proxyReq.end(bodyBuf);
    });
  });
}
