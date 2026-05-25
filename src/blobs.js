// Content-addressed blob store: each unit of request content is written once to
// <root>/blobs/<ab>/<sha256>.json (sharded by the first 2 hex chars, git-style)
// and referenced by "sha256:<hex>". Blobs are immutable / write-once.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export function blobRef(value) {
  // Hashing contract: JSON.stringify is key-order-sensitive, so callers must
  // preserve insertion order for dedup to hit (same content, different key
  // order hashes differently).
  const json = JSON.stringify(value);
  const hex = createHash("sha256").update(json).digest("hex");
  return { ref: `sha256:${hex}`, hex, json };
}

export function blobPath(root, ref) {
  const hex = ref.startsWith("sha256:") ? ref.slice("sha256:".length) : ref;
  return path.join(root, "blobs", hex.slice(0, 2), `${hex}.json`);
}

export function writeBlob(root, value) {
  const { ref, json } = blobRef(value);
  const file = blobPath(root, ref);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, file);
  }
  return ref;
}

export function readBlob(root, ref) {
  return JSON.parse(fs.readFileSync(blobPath(root, ref), "utf8"));
}

// The two array keys that hold conversation history (Anthropic vs OpenAI shape).
const HISTORY_KEYS = ["messages", "input"];

// Split a full record's request body into blobs + a v2 manifest. The big repeated
// pieces (system, tools, each history message) become blob refs; everything small
// (model, params, headers, response) stays inline.
export function packRecord(root, rec) {
  // Preserve the full request envelope (method, url, headers, …) minus the body,
  // which is split into meta + blob refs below (or stored raw, see below).
  const reqEnvelope = { ...(rec.request || {}) };
  const body = reqEnvelope.body;
  delete reqEnvelope.body;

  const base = {
    v: 2,
    id: rec.id, session: rec.session, seq: rec.seq, ts: rec.ts, format: rec.format,
    response: rec.response ?? null,
  };

  // Raw body: proxy stores non-JSON payloads as strings and empty bodies as null/array.
  // These can't be split into meta+blobs — store verbatim.
  const isObjBody = body !== null && typeof body === "object" && !Array.isArray(body);
  if (!isObjBody) {
    return { ...base, request: { ...reqEnvelope, rawBody: body ?? null } };
  }

  const historyKey = HISTORY_KEYS.find((k) => Array.isArray(body[k])) || null;
  const meta = { ...body };
  delete meta.system;
  delete meta.tools;
  for (const k of HISTORY_KEYS) delete meta[k];

  const system = body.system != null ? writeBlob(root, body.system) : null;
  const tools = Array.isArray(body.tools) ? writeBlob(root, body.tools) : null;
  const messages = historyKey ? body[historyKey].map((m) => writeBlob(root, m)) : [];

  return { ...base, request: { ...reqEnvelope, meta, historyKey, system, tools, messages } };
}

function safeBlob(root, ref) {
  try {
    return readBlob(root, ref);
  } catch {
    return { __missing_blob: ref };
  }
}

// Collect every blob ref a v2 manifest points at.
export function collectRefs(manifest, used) {
  const r = manifest.request || {};
  if (r.system) used.add(r.system);
  if (r.tools) used.add(r.tools);
  for (const ref of r.messages || []) used.add(ref);
}

// Mark-and-sweep: delete blobs not referenced by any remaining v2 manifest under
// `root`. `listSessions` lists session dir names; `sessionDir(root, name)` builds
// a session directory path. (Both injected to avoid a store<->blobs import cycle.)
//
// Assumes single-writer use: a blob written but whose referencing manifest isn't
// flushed yet could be seen as orphaned and deleted (harmless — re-created on the
// next write via dedup), so don't run GC concurrently with active captures.
export function gcBlobs(root, listSessions, sessionDir) {
  const used = new Set();
  for (const s of listSessions(root)) {
    const dir = sessionDir(root, s);
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const f of files) {
      let m;
      try {
        m = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      } catch {
        continue;
      }
      if (m && m.v === 2) collectRefs(m, used);
    }
  }
  const blobsDir = path.join(root, "blobs");
  if (!fs.existsSync(blobsDir)) return;
  for (const shard of fs.readdirSync(blobsDir)) {
    const shardDir = path.join(blobsDir, shard);
    let blobFiles;
    try {
      blobFiles = fs.readdirSync(shardDir);
    } catch {
      continue; // skip non-directory entries (.DS_Store, stray files)
    }
    for (const bf of blobFiles) {
      if (!bf.endsWith(".json")) continue;
      const ref = `sha256:${bf.replace(/\.json$/, "")}`;
      if (!used.has(ref)) fs.rmSync(path.join(shardDir, bf), { force: true });
    }
  }
}

// Reassemble the exact original full record from a v2 manifest.
export function unpackRecord(root, manifest) {
  const r = manifest.request || {};
  if ("rawBody" in r) {
    const { rawBody, ...envelope } = r;
    return {
      id: manifest.id, session: manifest.session, seq: manifest.seq,
      ts: manifest.ts, format: manifest.format,
      request: { ...envelope, body: rawBody },
      response: manifest.response ?? null,
    };
  }
  const { meta, historyKey, system, tools, messages, ...envelope } = r;
  // Key order is normalized here: the reconstructed body lists meta scalars first,
  // then system/tools/history — not the original insertion order. This is deepEqual-safe,
  // but do NOT JSON.stringify-fingerprint the reconstructed body expecting byte-identical
  // key order to the original.
  const body = { ...(meta || {}) };
  if (system != null) body.system = safeBlob(root, system);
  if (tools != null) body.tools = safeBlob(root, tools);
  if (historyKey) body[historyKey] = (messages || []).map((ref) => safeBlob(root, ref));
  return {
    id: manifest.id, session: manifest.session, seq: manifest.seq,
    ts: manifest.ts, format: manifest.format,
    request: { ...envelope, body },
    response: manifest.response ?? null,
  };
}
