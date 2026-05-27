// Dashboard web server: serves the SPA, exposes a small REST API over the
// captured logs, and pushes new entries live over SSE. All format-specific
// work is delegated to the adapter chosen per entry (anthropic | openai).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { summarize, listSessionsMulti, loadSessionMulti, readEntryByIdMulti } from "./store.js";
import { getAdapter, detectFormat } from "./formats/index.js";
import { aggregateSessionStats, latencyMs, requestTiming, sessionModels } from "./session-stats.js";
import { diffBlockLists } from "./diff.js";
import { renderExport } from "./export.js";
import { summarizeUsage } from "./usage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, "..", "web");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

// `store` is present in live (`ccglass claude`) mode; otherwise we read from disk.
export function createServer({ roots, store }) {
  const sseClients = new Set();

  if (store) {
    const push = (rec) => {
      const data = `data: ${JSON.stringify(summarize(rec))}\n\n`;
      for (const res of sseClients) res.write(data);
    };
    store.on("entry", push);
    store.on("update", push);
  }

  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

    try {
      if (p === "/api/sessions") return json(res, apiSessions(roots, store));
      if (p === "/api/requests") return json(res, apiRequests(roots, store, url));
      if (p === "/api/session-stats") return json(res, apiSessionStats(roots, store, url));
      if (p === "/api/usage") return json(res, summarizeUsage(roots));
      if (p.startsWith("/api/request/")) return json(res, apiRequest(roots, store, decodeURIComponent(p.slice("/api/request/".length))));
      if (p === "/api/diff") return json(res, apiDiff(roots, store, url));
      if (p === "/api/export") return apiExport(roots, store, url, res);
      if (p === "/api/stream") return stream(res, sseClients);
      return serveStatic(p, res);
    } catch (e) {
      json(res, { error: e.message }, 500);
    }
  });
}

// ---- API handlers --------------------------------------------------------

function getEntry(roots, store, id) {
  if (store) {
    const live = store.get(id);
    if (live) return live;
  }
  return readEntryByIdMulti(roots, id);
}

function apiSessions(roots, store) {
  return { sessions: listSessionsMulti(roots), live: store ? store.sessionId : null };
}

function sessionRecords(roots, store, session) {
  if (store && (!session || session === store.sessionId)) return store.entries;
  if (!session) return [];
  return loadSessionMulti(roots, session);
}

function apiRequests(roots, store, url) {
  const session = url.searchParams.get("session");
  return { entries: sessionRecords(roots, store, session).map(summarize) };
}

function apiSessionStats(roots, store, url) {
  const session = url.searchParams.get("session");
  if (!session) return { error: "session required" };
  const records = sessionRecords(roots, store, session);
  const model = url.searchParams.get("model") || "all";
  return {
    session,
    models: sessionModels(records),
    ...aggregateSessionStats(records, { model }),
  };
}

function apiRequest(roots, store, id) {
  const rec = getEntry(roots, store, id);
  if (!rec) return { error: "not found" };
  const fmt = detectFormat(rec);
  const A = getAdapter(fmt);
  const body = rec.request?.body || {};
  const response = rec.response?.raw ? A.reassemble(rec.response.raw) : rec.response;
  const usage = response?.usage || {};
  const timing = requestTiming(rec, usage);
  return {
    ...rec,
    latencyMs: latencyMs(rec),
    timing,
    format: fmt,
    parsed: {
      format: fmt,
      view: A.view(body),
      response,
      estTokens: A.estimateTokens(body),
      cost: A.cost(body.model, usage),
    },
  };
}

function apiDiff(roots, store, url) {
  const a = getEntry(roots, store, url.searchParams.get("a"));
  const b = getEntry(roots, store, url.searchParams.get("b"));
  if (!a || !b) return { error: "need both a and b" };
  const blocksA = getAdapter(detectFormat(a)).blocks(a.request?.body || {});
  const blocksB = getAdapter(detectFormat(b)).blocks(b.request?.body || {});
  return diffBlockLists(blocksA, blocksB);
}

function apiExport(roots, store, url, res) {
  const id = url.searchParams.get("id");
  const format = url.searchParams.get("format") || "md";
  const rec = getEntry(roots, store, id);
  if (!rec) return json(res, { error: "not found" }, 404);

  const { contentType, ext, body } = renderExport(rec, format);
  res.writeHead(200, { "content-type": contentType, ...attach(id, ext) });
  return res.end(body);
}

// ---- helpers -------------------------------------------------------------

function json(res, obj, code = 200) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function stream(res, clients) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(": connected\n\n");
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

function serveStatic(p, res) {
  const file = p === "/" ? "index.html" : p.replace(/^\//, "");
  const full = path.join(WEB_DIR, file);
  if (!full.startsWith(WEB_DIR) || !fs.existsSync(full)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(full)] || "application/octet-stream" });
  fs.createReadStream(full).pipe(res);
}

function attach(id, ext) {
  return { "content-disposition": `attachment; filename="ccglass-${id.replace(/\//g, "_")}.${ext}"` };
}
