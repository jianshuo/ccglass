// Forward proxy: HTTP CONNECT tunnel with selective TLS MITM.
// For clients that cannot redirect API traffic via BASE_URL env vars
// (e.g. CodeBuddy IDE), this proxy intercepts HTTPS requests by
// terminating TLS locally, capturing the plaintext request/response,
// then forwarding to the real upstream over a fresh TLS connection.
//
// Non-targeted hosts are piped through without interception.

import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import { signHost } from "./ca.js";

/**
 * Create a forward proxy server.
 * @param {object} opts
 * @param {object} opts.store - Store instance for persisting captured entries
 * @param {string[]} opts.targets - Hostnames to MITM (others pass through)
 * @param {object} opts.ca - { key: Buffer, cert: Buffer } CA credentials
 * @returns {http.Server}
 */
export function createForwardProxy({ store, targets, ca }) {
  const targetSet = new Set(targets.map((t) => t.toLowerCase()));

  const server = http.createServer((req, res) => {
    // Regular HTTP requests (non-CONNECT) — unlikely but handle gracefully
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("ccglass forward-proxy: use CONNECT for HTTPS traffic\n");
  });

  server.on("connect", (req, clientSocket, head) => {
    const [host, portStr] = req.url.split(":");
    const port = parseInt(portStr) || 443;

    if (!targetSet.has(host.toLowerCase())) {
      // Not a target: transparent TCP tunnel (no MITM)
      tunnel(host, port, clientSocket, head);
      return;
    }

    // Target host: MITM interception
    mitm(host, port, clientSocket, head, ca, store);
  });

  return server;
}

/** Transparent TCP tunnel — no interception. */
function tunnel(host, port, clientSocket, head) {
  const upstream = net.connect(port, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", () => clientSocket.end());
  clientSocket.on("error", () => upstream.end());
}

/** TLS MITM: terminate client TLS, capture, forward to real upstream. */
function mitm(host, port, clientSocket, head, ca, store) {
  const hostCert = signHost(host, ca);

  // Tell client the tunnel is established
  clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

  // Upgrade client connection to TLS (we act as the server)
  const tlsClient = new tls.TLSSocket(clientSocket, {
    isServer: true,
    key: hostCert.key,
    cert: hostCert.cert,
  });

  // Buffer the full HTTP request from client
  let reqBuf = Buffer.alloc(0);
  let headersParsed = false;
  let contentLength = -1;
  let headers = "";
  let headerEndIdx = -1;

  tlsClient.on("data", onData);
  tlsClient.on("error", () => {});
  tlsClient.on("end", () => {});

  function onData(chunk) {
    reqBuf = Buffer.concat([reqBuf, chunk]);

    if (!headersParsed) {
      headerEndIdx = reqBuf.indexOf("\r\n\r\n");
      if (headerEndIdx < 0) return; // wait for full headers
      headersParsed = true;
      headers = reqBuf.slice(0, headerEndIdx).toString();
      const clMatch = headers.match(/content-length:\s*(\d+)/i);
      contentLength = clMatch ? parseInt(clMatch[1]) : 0;
    }

    const bodyStart = headerEndIdx + 4;
    const bodyReceived = reqBuf.length - bodyStart;

    if (bodyReceived >= contentLength) {
      tlsClient.removeListener("data", onData);
      forwardRequest(host, port, reqBuf, headers, bodyStart, tlsClient, store);
    }
  }
}

/** Forward the captured request to the real upstream, stream response back. */
function forwardRequest(host, port, reqBuf, headers, bodyStart, tlsClient, store) {
  const headerLines = headers.split("\r\n");
  const firstLine = headerLines[0]; // e.g. "POST /v2/chat/completions HTTP/1.1"
  const [method, urlPath] = firstLine.split(" ");

  const bodyBuf = reqBuf.slice(bodyStart);

  // Decode body for logging (handle gzip)
  let body;
  const isGzip = /content-encoding:\s*gzip/i.test(headers);
  try {
    const raw = isGzip ? zlib.gunzipSync(bodyBuf) : bodyBuf;
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    body = bodyBuf.length ? (isGzip ? "[gzip binary]" : bodyBuf.toString("utf8")) : null;
  }

  // Parse request headers into object
  const reqHeaders = {};
  for (let i = 1; i < headerLines.length; i++) {
    const colon = headerLines[i].indexOf(":");
    if (colon > 0) {
      const k = headerLines[i].slice(0, colon).trim().toLowerCase();
      const v = headerLines[i].slice(colon + 1).trim();
      reqHeaders[k] = v;
    }
  }

  // Record in store
  const rec = store.add({
    request: {
      method,
      url: urlPath,
      headers: reqHeaders,
      body,
    },
  });
  rec.startedAt = Date.now();

  // Connect to real upstream
  const upstream = tls.connect({ host, port, servername: host }, () => {
    // Forward the original raw request (preserving gzip encoding)
    upstream.write(reqBuf);
  });

  // Stream response back to client and capture it
  const respChunks = [];
  let firstByteAt;
  let respHeaderParsed = false;
  let respHeaderBuf = Buffer.alloc(0);
  let respStatus = null;
  let respHeaders = {};
  let isChunked = false;
  let bodyChunks = [];

  upstream.on("data", (chunk) => {
    if (firstByteAt == null) firstByteAt = Date.now();
    respChunks.push(chunk);
    tlsClient.write(chunk);
  });

  upstream.on("end", () => {
    tlsClient.end();
    const doneAt = Date.now();
    const rawResp = Buffer.concat(respChunks).toString("utf8");

    // Parse status from response
    const statusMatch = rawResp.match(/^HTTP\/\d\.\d (\d+)/);
    respStatus = statusMatch ? parseInt(statusMatch[1]) : null;

    // Extract response headers
    const respHeaderEnd = rawResp.indexOf("\r\n\r\n");
    const respHeaderStr = respHeaderEnd > 0 ? rawResp.slice(0, respHeaderEnd) : "";
    for (const line of respHeaderStr.split("\r\n").slice(1)) {
      const colon = line.indexOf(":");
      if (colon > 0) {
        const k = line.slice(0, colon).trim().toLowerCase();
        const v = line.slice(colon + 1).trim();
        respHeaders[k] = v;
      }
    }

    // Body is everything after headers
    let respBody = respHeaderEnd > 0 ? rawResp.slice(respHeaderEnd + 4) : rawResp;

    // Decode chunked transfer encoding for storage
    if (respHeaders["transfer-encoding"]?.includes("chunked")) {
      respBody = decodeChunked(respBody);
    }

    rec.response = {
      status: respStatus,
      headers: respHeaders,
      raw: respBody,
      firstByteAt: firstByteAt ?? doneAt,
      finishedAt: doneAt,
    };
    store.update(rec);
  });

  upstream.on("error", (e) => {
    tlsClient.end();
    rec.response = { error: e.message, finishedAt: Date.now() };
    store.update(rec);
  });

  tlsClient.on("error", () => upstream.end());
}

/** Decode HTTP chunked transfer encoding, stripping chunk-size lines. */
function decodeChunked(raw) {
  const out = [];
  let pos = 0;
  while (pos < raw.length) {
    // Find end of chunk-size line
    const lineEnd = raw.indexOf("\r\n", pos);
    if (lineEnd < 0) break;
    const sizeLine = raw.slice(pos, lineEnd).trim();
    const size = parseInt(sizeLine, 16);
    if (isNaN(size) || size === 0) break;
    // Chunk data starts after the \r\n
    const dataStart = lineEnd + 2;
    const dataEnd = dataStart + size;
    if (dataEnd > raw.length) {
      // Incomplete chunk — take what we have
      out.push(raw.slice(dataStart));
      break;
    }
    out.push(raw.slice(dataStart, dataEnd));
    // Skip trailing \r\n after chunk data
    pos = dataEnd + 2;
  }
  return out.join("");
}
