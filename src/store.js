// Persistence layer: every captured request/response pair is written to
// .ccglass/<session>/NNNN.json. The Store also acts as an event bus so the
// dashboard server can push new entries live.

import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

const mask = (v) =>
  String(v)
    .replace(/(Bearer\s+\S{6})\S+(\S{4})/g, "$1…REDACTED…$2")
    .replace(/(sk-ant-[\w-]{6})\S+(\S{4})/g, "$1…REDACTED…$2");

const pad = (n) => String(n).padStart(4, "0");

export class Store extends EventEmitter {
  constructor({ root, redact = true, format = "anthropic" }) {
    super();
    this.root = root;
    this.redact = redact;
    this.format = format;
    this.sessionId = new Date().toISOString().replace(/[:.]/g, "-");
    this.sessionDir = path.join(root, this.sessionId);
    fs.mkdirSync(this.sessionDir, { recursive: true });
    this.entries = [];
    this.seq = 0;
  }

  _maskHeaders(h) {
    if (!this.redact || !h) return h;
    const c = { ...h };
    for (const k of Object.keys(c)) {
      const lk = k.toLowerCase();
      if (lk === "authorization" || lk === "x-api-key") c[k] = mask(c[k]);
    }
    return c;
  }

  _file(seq) {
    return path.join(this.sessionDir, `${pad(seq)}.json`);
  }

  // Record a request (response filled in later via update()).
  add({ request }) {
    const seq = ++this.seq;
    const rec = {
      id: `${this.sessionId}/${pad(seq)}`,
      session: this.sessionId,
      seq,
      ts: Date.now(),
      format: this.format,
      request: { ...request, headers: this._maskHeaders(request.headers) },
      response: null,
    };
    fs.writeFileSync(this._file(seq), JSON.stringify(rec, null, 2));
    this.entries.push(rec);
    this.emit("entry", rec);
    return rec;
  }

  update(rec) {
    fs.writeFileSync(this._file(rec.seq), JSON.stringify(rec, null, 2));
    this.emit("update", rec);
  }

  list() {
    return this.entries.map(summarize);
  }

  get(id) {
    return this.entries.find((e) => e.id === id) || readEntryById(this.root, id);
  }
}

// ---- shared helpers also used by `ccglass view` (no live store) ------------

export function summarize(rec) {
  const b = rec.request?.body || {};
  const items = Array.isArray(b.messages) ? b.messages : Array.isArray(b.input) ? b.input : [];
  // Count tool calls that actually happened in this request (anthropic
  // tool_use blocks, plus openai-style tool_calls), distinct from nTools
  // which is just how many tools were *offered*.
  let nToolUse = 0;
  for (const m of items) {
    const c = Array.isArray(m?.content) ? m.content : [];
    for (const blk of c) if (blk?.type === "tool_use") nToolUse++;
    if (Array.isArray(m?.tool_calls)) nToolUse += m.tool_calls.length;
  }
  return {
    id: rec.id,
    session: rec.session,
    seq: rec.seq,
    ts: rec.ts,
    format: rec.format || null,
    method: rec.request?.method,
    url: rec.request?.url,
    model: b.model,
    nMessages: items.length,
    nTools: Array.isArray(b.tools) ? b.tools.length : 0,
    nToolUse,
    status: rec.response?.status ?? null,
    error: rec.response?.error ?? null,
    pending: !rec.response,
  };
}

export function listSessions(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();
}

export function loadSession(root, session) {
  const dir = path.join(root, session);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}

export function readEntryById(root, id) {
  const [session, seq] = id.split("/");
  const file = path.join(root, session, `${seq}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
