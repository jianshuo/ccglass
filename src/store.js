// Persistence layer: every captured request/response pair is written to
// <root>/<session>/NNNN.json (default ~/.ccglass/sessions/<project-key>/).
// The Store also acts as an event bus so the dashboard server can push new
// entries live.

import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { packRecord, unpackRecord, gcBlobs } from "./blobs.js";

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
    this._persist(rec);
    this.entries.push(rec);
    this.emit("entry", rec);
    return rec;
  }

  update(rec) {
    this._persist(rec);
    this.emit("update", rec);
  }

  // Write the v2 manifest (request content split into content-addressed blobs).
  _persist(rec) {
    const manifest = packRecord(this.root, rec);
    fs.writeFileSync(this._file(rec.seq), JSON.stringify(manifest, null, 2));
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
    .filter((d) => d.isDirectory() && d.name !== "blobs")
    .map((d) => d.name)
    .sort()
    .reverse();
}

export function hasCapturedLogs(root) {
  if (!fs.existsSync(root)) return false;
  for (const s of listSessions(root)) {
    const dir = path.join(root, s);
    try {
      if (fs.readdirSync(dir).some((f) => f.endsWith(".json"))) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

/** Parse `<session>/<seq>` entry ids; returns null when malformed. */
export function parseEntryId(id) {
  const i = id.indexOf("/");
  if (i <= 0 || i === id.length - 1) return null;
  const session = id.slice(0, i);
  const seq = id.slice(i + 1);
  if (!session || !seq || seq.includes("/")) return null;
  return { session, seq };
}

function shouldReplaceRecord(prev, rec, prevMtime, newMtime) {
  const pts = prev.ts ?? 0;
  const rts = rec.ts ?? 0;
  if (rts > pts) return true;
  if (rts < pts) return false;
  return newMtime > prevMtime;
}

/** Read one capture file; returns null on parse errors. Normalizes id to the path key. */
function readRecordFile(file, id, root) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (raw && raw.v === 2) {
    try {
      const rec = unpackRecord(root, raw);
      rec.id = id;
      return rec;
    } catch {
      return null;
    }
  }
  // Legacy full record: hand it back, and opportunistically repack to v2 in place.
  raw.id = id;
  tryMigrate(file, root, raw);
  return raw;
}

// Repack a legacy full record into a v2 manifest on disk. Atomic (temp + rename)
// and best-effort: a read-only root (e.g. a legacy ./.ccglass) is silently skipped
// so migration failure never breaks a read.
function tryMigrate(file, root, rec) {
  try {
    const manifest = packRecord(root, rec);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    /* read-only root or transient error — keep serving reads */
  }
}

export function listSessionsMulti(roots) {
  const seen = new Set();
  const sessions = [];
  for (const root of roots) {
    for (const s of listSessions(root)) {
      if (!seen.has(s)) {
        seen.add(s);
        sessions.push(s);
      }
    }
  }
  sessions.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  return sessions;
}

export function loadSessionMulti(roots, session) {
  const byId = new Map();
  const fileMtime = new Map();

  for (const root of roots) {
    const dir = path.join(root, session);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
      const file = path.join(dir, f);
      const seq = f.replace(/\.json$/, "");
      const id = `${session}/${seq}`;
      const st = fs.statSync(file);
      const prev = byId.get(id);

      const rec = readRecordFile(file, id, root);
      if (!rec) continue;

      if (prev) {
        const firstMtime = fileMtime.get(id) ?? 0;
        if (shouldReplaceRecord(prev, rec, firstMtime, st.mtimeMs)) {
          byId.set(id, rec);
          fileMtime.set(id, st.mtimeMs);
        }
        continue;
      }

      byId.set(id, rec);
      fileMtime.set(id, st.mtimeMs);
    }
  }

  return [...byId.values()].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
}

export function readEntryByIdMulti(roots, id) {
  const parts = parseEntryId(id);
  if (!parts) return null;
  const { session, seq } = parts;
  let best = null;
  let bestMtime = 0;
  for (const root of roots) {
    const rec = readEntryById(root, id);
    if (!rec) continue;
    const file = path.join(root, session, `${seq}.json`);
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      /* ignore */
    }
    if (!best) {
      best = rec;
      bestMtime = mtime;
      continue;
    }
    const rts = rec.ts ?? 0;
    const bts = best.ts ?? 0;
    if (rts > bts || (rts === bts && mtime > bestMtime)) {
      best = rec;
      bestMtime = mtime;
    }
  }
  return best;
}

export function loadSession(root, session) {
  const dir = path.join(root, session);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const seq = f.replace(/\.json$/, "");
    const rec = readRecordFile(path.join(dir, f), `${session}/${seq}`, root);
    if (rec) out.push(rec);
  }
  return out;
}

export function readEntryById(root, id) {
  const parts = parseEntryId(id);
  if (!parts) return null;
  const file = path.join(root, parts.session, `${parts.seq}.json`);
  if (!fs.existsSync(file)) return null;
  return readRecordFile(file, id, root);
}

/** Delete a session directory under `root`, then GC now-orphaned blobs. */
export function rmSession(root, session) {
  fs.rmSync(path.join(root, session), { recursive: true, force: true });
  gcBlobs(root, listSessions, (r, s) => path.join(r, s));
}
