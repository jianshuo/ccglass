# Content-Addressed Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the O(n²) capture-storage bloat in ccglass by storing each unit of request content once, content-addressed by sha256, with a v2 manifest of blob references.

**Architecture:** A new `src/blobs.js` module owns content-addressed blob IO and lossless pack/unpack between full records and v2 manifests. `src/store.js` writes v2 manifests and reconstructs them transparently in `readRecordFile` (so every consumer is unaffected), auto-migrating legacy files on read. `src/cli.js` gains `repack` (full-pass migration) and `rm` (delete session + mark-and-sweep blob GC).

**Tech Stack:** Node.js (ESM), `node:crypto` sha256, `node:fs`, `node --test`.

**Spec:** `docs/superpowers/specs/2026-05-25-content-addressed-storage-design.md`

---

## File Structure

- **Create `src/blobs.js`** — blob IO (`writeBlob`, `readBlob`, `blobPath`, `blobRef`) + record pack/unpack (`packRecord`, `unpackRecord`) + GC helper (`gcBlobs`, `collectRefs`).
- **Modify `src/store.js`** — write path (`Store._persist` used by `add`/`update`), read path (`readRecordFile` reconstructs v2 + threads `root`), auto-migration (`tryMigrate`), and a `rmSession` helper.
- **Modify `src/cli.js`** — dispatch + help for `repack` and `rm`.
- **Modify `src/log-cli.js`** — export `repack` and `rmCmd` CLI handlers (this file already hosts `migrate`/`exportEntry`).
- **Create `test/blobs.test.js`** — blob dedup, round-trip, pack/unpack losslessness, missing-blob, GC.
- **Modify `test/store.test.js`** — v2 read, legacy read, auto-migration idempotency, O(N) dedup assertion.

---

## Task 1: Blob IO in `src/blobs.js`

**Files:**
- Create: `src/blobs.js`
- Test: `test/blobs.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/blobs.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeBlob, readBlob, blobPath } from "../src/blobs.js";

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-blob-"));

test("writeBlob is content-addressed and dedups identical content", () => {
  const root = tmpRoot();
  const ref1 = writeBlob(root, { role: "user", content: "hi" });
  const ref2 = writeBlob(root, { role: "user", content: "hi" });
  assert.equal(ref1, ref2);
  assert.match(ref1, /^sha256:[0-9a-f]{64}$/);

  // exactly one blob file on disk
  const file = blobPath(root, ref1);
  assert.ok(fs.existsSync(file));
  // sharded by first 2 hex chars
  const hex = ref1.slice("sha256:".length);
  assert.equal(path.basename(path.dirname(file)), hex.slice(0, 2));
});

test("readBlob round-trips the stored value", () => {
  const root = tmpRoot();
  const value = { role: "assistant", content: [{ type: "text", text: "x" }] };
  const ref = writeBlob(root, value);
  assert.deepEqual(readBlob(root, ref), value);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/blobs.test.js`
Expected: FAIL — cannot resolve `../src/blobs.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/blobs.js`:

```js
// Content-addressed blob store: each unit of request content is written once to
// <root>/blobs/<ab>/<sha256>.json (sharded by the first 2 hex chars, git-style)
// and referenced by "sha256:<hex>". Blobs are immutable / write-once.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export function blobRef(value) {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/blobs.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/blobs.js test/blobs.test.js
git commit -m "feat(blobs): content-addressed blob IO with dedup"
```

---

## Task 2: Lossless `packRecord` / `unpackRecord`

**Files:**
- Modify: `src/blobs.js`
- Test: `test/blobs.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/blobs.test.js`:

```js
import { packRecord, unpackRecord } from "../src/blobs.js";

function makeRec(body) {
  return {
    id: "S/0001", session: "S", seq: 1, ts: 123, format: "anthropic",
    request: { headers: { "x-api-key": "masked" }, body },
    response: { status: 200, raw: "ok" },
  };
}

test("pack -> unpack is lossless: anthropic system array + tools + messages", () => {
  const root = tmpRoot();
  const body = {
    model: "claude-opus-4-7", max_tokens: 1024,
    system: [{ type: "text", text: "sys" }],
    tools: [{ name: "t", description: "d" }],
    messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }],
  };
  const rec = makeRec(body);
  const manifest = packRecord(root, rec);
  assert.equal(manifest.v, 2);
  assert.deepEqual(unpackRecord(root, manifest), rec);
});

test("pack -> unpack is lossless: openai input, no tools, system as string", () => {
  const root = tmpRoot();
  const body = {
    model: "gpt-x", system: "plain string",
    input: [{ role: "user", content: "hi" }],
  };
  const rec = makeRec(body);
  rec.format = "openai";
  const manifest = packRecord(root, rec);
  assert.deepEqual(unpackRecord(root, manifest), rec);
});

test("pack -> unpack: no system, no tools, empty messages", () => {
  const root = tmpRoot();
  const rec = makeRec({ model: "m", messages: [], tools: [] });
  assert.deepEqual(unpackRecord(root, packRecord(root, rec)), rec);
});

test("unpackRecord backfills a placeholder for a missing blob", () => {
  const root = tmpRoot();
  const rec = makeRec({ model: "m", messages: [{ role: "user", content: "hi" }] });
  const manifest = packRecord(root, rec);
  // delete the message blob to simulate corruption
  fs.rmSync(blobPath(root, manifest.request.messages[0]), { force: true });
  const out = unpackRecord(root, manifest);
  assert.deepEqual(out.request.body.messages[0], { __missing_blob: manifest.request.messages[0] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/blobs.test.js`
Expected: FAIL — `packRecord`/`unpackRecord` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/blobs.js`:

```js
// The two array keys that hold conversation history (Anthropic vs OpenAI shape).
const HISTORY_KEYS = ["messages", "input"];

// Split a full record's request body into blobs + a v2 manifest. The big repeated
// pieces (system, tools, each history message) become blob refs; everything small
// (model, params, headers, response) stays inline.
export function packRecord(root, rec) {
  const body = (rec.request && rec.request.body) || {};
  const historyKey = HISTORY_KEYS.find((k) => Array.isArray(body[k])) || null;

  const meta = { ...body };
  delete meta.system;
  delete meta.tools;
  for (const k of HISTORY_KEYS) delete meta[k];

  const system = body.system != null ? writeBlob(root, body.system) : null;
  const tools = Array.isArray(body.tools) ? writeBlob(root, body.tools) : null;
  const messages = historyKey ? body[historyKey].map((m) => writeBlob(root, m)) : [];

  return {
    v: 2,
    id: rec.id, session: rec.session, seq: rec.seq, ts: rec.ts, format: rec.format,
    request: {
      headers: (rec.request && rec.request.headers) ?? {},
      meta,
      historyKey,
      system,
      tools,
      messages,
    },
    response: rec.response ?? null,
  };
}

function safeBlob(root, ref) {
  try {
    return readBlob(root, ref);
  } catch {
    return { __missing_blob: ref };
  }
}

// Reassemble the exact original full record from a v2 manifest.
export function unpackRecord(root, manifest) {
  const r = manifest.request || {};
  const body = { ...(r.meta || {}) };
  if (r.system != null) body.system = safeBlob(root, r.system);
  if (r.tools != null) body.tools = safeBlob(root, r.tools);
  if (r.historyKey) body[r.historyKey] = (r.messages || []).map((ref) => safeBlob(root, ref));
  return {
    id: manifest.id,
    session: manifest.session,
    seq: manifest.seq,
    ts: manifest.ts,
    format: manifest.format,
    request: { headers: r.headers ?? {}, body },
    response: manifest.response ?? null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/blobs.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/blobs.js test/blobs.test.js
git commit -m "feat(blobs): lossless packRecord/unpackRecord"
```

---

## Task 3: Write path emits v2 manifests

**Files:**
- Modify: `src/store.js` (constructor already stores `this.root`; `add` at ~45-60, `update` at ~62-65)
- Test: `test/store.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/store.test.js`:

```js
test("Store writes a v2 manifest with blob refs; in-memory rec stays full", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-v2-"));
  const store = new Store({ root });
  const rec = store.add({
    request: {
      method: "POST", url: "/v1/messages",
      headers: { authorization: "Bearer sk-ant-oat01-SECRETSECRETSECRET-TAIL" },
      body: { model: "m", messages: [{ role: "user", content: "hi" }], tools: [] },
    },
  });
  rec.response = { status: 200, raw: "ok" };
  store.update(rec);

  // On disk: v2 manifest with refs, NOT the inline messages array
  const seqFile = path.join(root, store.sessionId, "0001.json");
  const onDisk = JSON.parse(fs.readFileSync(seqFile, "utf8"));
  assert.equal(onDisk.v, 2);
  assert.ok(Array.isArray(onDisk.request.messages));
  assert.match(onDisk.request.messages[0], /^sha256:/);
  assert.equal(onDisk.request.body, undefined);

  // In memory: still a full rec for live dashboard push
  assert.deepEqual(rec.request.body.messages, [{ role: "user", content: "hi" }]);

  // Blob directory exists
  assert.ok(fs.existsSync(path.join(root, "blobs")));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/store.test.js`
Expected: FAIL — on-disk file has `v` undefined and `request.body` present.

- [ ] **Step 3: Write minimal implementation**

In `src/store.js`, add the import near the top (after the existing imports):

```js
import { packRecord } from "./blobs.js";
```

Replace the `add` and `update` methods (current lines ~44-65) with:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/store.test.js`
Expected: the new test PASSES. (Other tests in this file may still fail until Task 4 — that is expected; do not "fix" them here.)

- [ ] **Step 5: Commit**

```bash
git add src/store.js test/store.test.js
git commit -m "feat(store): write v2 manifests via packRecord"
```

---

## Task 4: Read path reconstructs v2 (thread `root`)

**Files:**
- Modify: `src/store.js` (`readRecordFile` ~150-158 and its callers `loadSessionMulti` ~189, `loadSession` ~246, `readEntryById` ~257)
- Test: `test/store.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/store.test.js`:

```js
import { loadSession as _loadSession, readEntryById as _readEntryById } from "../src/store.js";

test("v2 manifests are reconstructed transparently by loadSession/readEntryById", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-r2-"));
  const store = new Store({ root });
  const rec = store.add({
    request: {
      method: "POST", url: "/v1/messages", headers: {},
      body: { model: "m", system: [{ type: "text", text: "s" }],
              messages: [{ role: "user", content: "hi" }], tools: [{ name: "t" }] },
    },
  });
  rec.response = { status: 200, raw: "ok" };
  store.update(rec);

  const session = store.sessionId;
  const loaded = _loadSession(root, session);
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0].request.body.messages, [{ role: "user", content: "hi" }]);
  assert.deepEqual(loaded[0].request.body.system, [{ type: "text", text: "s" }]);
  assert.deepEqual(loaded[0].request.body.tools, [{ name: "t" }]);

  const one = _readEntryById(root, `${session}/0001`);
  assert.equal(one.response.status, 200);
  assert.deepEqual(one.request.body.messages, [{ role: "user", content: "hi" }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/store.test.js`
Expected: FAIL — `loadSession` returns the raw manifest (`request.messages` refs), so `request.body` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `src/store.js`, update the import added in Task 3 to also pull in `unpackRecord`:

```js
import { packRecord, unpackRecord } from "./blobs.js";
```

Replace `readRecordFile` (current ~149-158) with a version that takes `root` and reconstructs v2:

```js
/** Read one capture file; returns null on parse errors. Normalizes id to the path key. */
function readRecordFile(file, id, root) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (raw && raw.v === 2) {
    const rec = unpackRecord(root, raw);
    rec.id = id;
    return rec;
  }
  // Legacy full record: return as-is (auto-migration is added in Task 5).
  raw.id = id;
  return raw;
}
```

Update the three call sites to pass `root`:

- In `loadSessionMulti` (the line currently `const rec = readRecordFile(file, id);`):

```js
      const rec = readRecordFile(file, id, root);
```

- In `loadSession` (currently `const rec = readRecordFile(path.join(dir, f), \`${session}/${seq}\`);`):

```js
    const rec = readRecordFile(path.join(dir, f), `${session}/${seq}`, root);
```

- In `readEntryById` (currently `return readRecordFile(file, id);`):

```js
  return readRecordFile(file, id, root);
```

(`readEntryByIdMulti` calls `readEntryById(root, id)`, so it needs no change.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test`
Expected: ALL tests pass (the full suite, including the previously-failing store tests from Task 3).

- [ ] **Step 5: Commit**

```bash
git add src/store.js test/store.test.js
git commit -m "feat(store): reconstruct v2 manifests transparently in readRecordFile"
```

---

## Task 5: Auto-migration on read

**Files:**
- Modify: `src/store.js` (`readRecordFile` legacy branch + new `tryMigrate` helper)
- Test: `test/store.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/store.test.js`:

```js
test("legacy NNNN.json is repacked to v2 in place on read, idempotently", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-mig-"));
  const session = "2020-01-01T00-00-00-000Z";
  const dir = path.join(root, session);
  fs.mkdirSync(dir, { recursive: true });
  const legacy = {
    id: `${session}/0001`, session, seq: 1, ts: 1, format: "anthropic",
    request: { headers: {}, body: { model: "m", messages: [{ role: "user", content: "hi" }], tools: [] } },
    response: { status: 200, raw: "ok" },
  };
  const file = path.join(dir, "0001.json");
  fs.writeFileSync(file, JSON.stringify(legacy, null, 2));

  // First read returns the full rec AND rewrites the file as v2
  const loaded = _loadSession(root, session);
  assert.deepEqual(loaded[0].request.body.messages, [{ role: "user", content: "hi" }]);
  const afterFirst = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(afterFirst.v, 2);

  // Second read is idempotent: still v2, still reconstructs the same rec
  const reloaded = _loadSession(root, session);
  assert.deepEqual(reloaded[0].request.body.messages, [{ role: "user", content: "hi" }]);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).v, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/store.test.js`
Expected: FAIL — after first read the file still has `v` undefined (no migration yet).

- [ ] **Step 3: Write minimal implementation**

In `src/store.js`, replace the legacy branch of `readRecordFile` (the two lines `raw.id = id;` / `return raw;`) with:

```js
  // Legacy full record: hand it back, and opportunistically repack to v2 in place.
  raw.id = id;
  tryMigrate(file, root, raw);
  return raw;
```

Add this helper just below `readRecordFile`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test`
Expected: ALL tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/store.js test/store.test.js
git commit -m "feat(store): auto-migrate legacy records to v2 on read"
```

---

## Task 6: Dedup guard — storage is O(N), not O(N²)

**Files:**
- Test: `test/store.test.js` (assertion-only task; guards the core purpose)

- [ ] **Step 1: Write the failing test**

Append to `test/store.test.js`:

```js
function countBlobs(root) {
  const blobsDir = path.join(root, "blobs");
  if (!fs.existsSync(blobsDir)) return 0;
  let n = 0;
  for (const shard of fs.readdirSync(blobsDir)) {
    n += fs.readdirSync(path.join(blobsDir, shard)).filter((f) => f.endsWith(".json")).length;
  }
  return n;
}

test("growing-prefix sessions store O(N) blobs, not O(N^2)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-dedup-"));
  const store = new Store({ root });
  const N = 20;
  const messages = [];
  const tools = [{ name: "t", description: "x".repeat(500) }]; // identical every call
  for (let i = 0; i < N; i++) {
    messages.push({ role: "user", content: `turn ${i}` });
    messages.push({ role: "assistant", content: `reply ${i}` });
    const rec = store.add({
      request: { method: "POST", url: "/v1/messages", headers: {},
        body: { model: "m", tools, messages: messages.map((m) => ({ ...m })) } },
    });
    rec.response = { status: 200, raw: "ok" };
    store.update(rec);
  }
  // Unique blobs: 2N messages + 1 tools blob (deduped across all calls). The O(N^2)
  // model would have stored ~N*(2N) message copies. Allow a small margin.
  const blobs = countBlobs(root);
  assert.ok(blobs <= 2 * N + 5, `expected ~${2 * N + 1} blobs, got ${blobs}`);
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test test/store.test.js`
Expected: PASS (Tasks 1-5 already provide dedup; this test documents and guards it).

- [ ] **Step 3: Commit**

```bash
git add test/store.test.js
git commit -m "test(store): guard O(N) blob dedup for growing-prefix sessions"
```

---

## Task 7: `gcBlobs` + `rmSession` (delete-time mark-and-sweep)

**Files:**
- Modify: `src/blobs.js` (add `collectRefs`, `gcBlobs`)
- Modify: `src/store.js` (add `rmSession`, importing `gcBlobs`)
- Test: `test/blobs.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/blobs.test.js`:

```js
import { Store, rmSession, listSessions } from "../src/store.js";

test("rmSession deletes the session and GCs only orphaned blobs", () => {
  const root = tmpRoot();
  // Session A and B share an identical message; each also has a unique one.
  const shared = { role: "user", content: "shared" };
  const mk = (uniqueText) => ({
    request: { method: "POST", url: "/v1/messages", headers: {},
      body: { model: "m", tools: [], messages: [shared, { role: "user", content: uniqueText }] } },
  });

  const a = new Store({ root });
  const ra = a.add(mk("only-A")); ra.response = { status: 200 }; a.update(ra);
  const sharedRef = JSON.parse(
    fs.readFileSync(path.join(root, a.sessionId, "0001.json"), "utf8")
  ).request.messages[0];

  // Force a distinct session id for B.
  const b = new Store({ root });
  b.sessionId = a.sessionId + "-B";
  b.sessionDir = path.join(root, b.sessionId);
  fs.mkdirSync(b.sessionDir, { recursive: true });
  const rb = b.add(mk("only-B")); rb.response = { status: 200 }; b.update(rb);

  rmSession(root, a.sessionId);

  // Session A gone, B remains
  assert.ok(!listSessions(root).includes(a.sessionId));
  assert.ok(listSessions(root).includes(b.sessionId));
  // Shared blob still present (referenced by B); "only-A" blob gone
  assert.ok(fs.existsSync(blobPath(root, sharedRef)));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/blobs.test.js`
Expected: FAIL — `rmSession` / `gcBlobs` not defined.

- [ ] **Step 3: Write minimal implementation**

Append to `src/blobs.js`:

```js
// Collect every blob ref a v2 manifest points at.
export function collectRefs(manifest, used) {
  const r = manifest.request || {};
  if (r.system) used.add(r.system);
  if (r.tools) used.add(r.tools);
  for (const ref of r.messages || []) used.add(ref);
}

// Mark-and-sweep: delete blobs not referenced by any remaining v2 manifest under
// `root`. `listSession` lists session dir names; `readManifest` parses one file.
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
    for (const bf of fs.readdirSync(shardDir)) {
      if (!bf.endsWith(".json")) continue;
      const ref = `sha256:${bf.replace(/\.json$/, "")}`;
      if (!used.has(ref)) fs.rmSync(path.join(shardDir, bf), { force: true });
    }
  }
}
```

In `src/store.js`, extend the blobs import:

```js
import { packRecord, unpackRecord, gcBlobs } from "./blobs.js";
```

Add this exported function at the end of `src/store.js` (after `readEntryById`):

```js
/** Delete a session directory under `root`, then GC now-orphaned blobs. */
export function rmSession(root, session) {
  fs.rmSync(path.join(root, session), { recursive: true, force: true });
  gcBlobs(root, listSessions, (r, s) => path.join(r, s));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test`
Expected: ALL tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/blobs.js src/store.js test/blobs.test.js
git commit -m "feat(store): rmSession with mark-and-sweep blob GC"
```

---

## Task 8: CLI `repack` and `rm`

**Files:**
- Modify: `src/log-cli.js` (add `repack`, `rmCmd` handlers)
- Modify: `src/cli.js` (dispatch + help + re-export)
- Test: `test/cli.test.js`

First inspect the current `log-cli.js` imports/exports so the new handlers follow the file's style:

Run: `sed -n '1,20p' src/log-cli.js`

- [ ] **Step 1: Write the failing test**

Append to `test/cli.test.js`:

```js
import fs from "node:fs";
import os from "node:os";

test("ccglass rm deletes a session directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-rmcli-"));
  const session = "2020-01-01T00-00-00-000Z";
  const dir = path.join(root, session);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "0001.json"), JSON.stringify({
    v: 2, id: `${session}/0001`, session, seq: 1, ts: 1, format: "anthropic",
    request: { headers: {}, meta: { model: "m" }, historyKey: "messages",
               system: null, tools: null, messages: [] },
    response: null,
  }));

  const { code } = await run(["rm", session, "--dir", root]);
  assert.equal(code, 0);
  assert.ok(!fs.existsSync(dir));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cli.test.js`
Expected: FAIL — `rm` is treated as a provider to wrap (non-zero exit / wrong behavior).

- [ ] **Step 3: Write minimal implementation**

Append to `src/log-cli.js` (uses `rmSession` and the read helpers from store.js):

```js
import { rmSession, listSessions, loadSession } from "./store.js";

// `ccglass repack [session]` — force-migrate legacy records to v2 by reading them
// (reads auto-migrate in place). With no session, repacks every session.
export function repack(opts) {
  for (const root of opts.readRoots) {
    const sessions = listSessions(root);
    for (const s of sessions) {
      if (opts.session && s !== opts.session) continue;
      loadSession(root, s); // side effect: rewrites legacy files as v2
    }
  }
  process.stdout.write("ccglass: repack complete\n");
}

// `ccglass rm <session>` — delete a session across read roots and GC orphan blobs.
export function rmCmd(session, opts) {
  if (!session) {
    process.stderr.write("ccglass rm: usage: ccglass rm <session>\n");
    process.exitCode = 1;
    return;
  }
  for (const root of opts.readRoots) {
    if (fs.existsSync(path.join(root, session))) rmSession(root, session);
  }
  process.stdout.write(`ccglass: removed ${session}\n`);
}
```

If `src/log-cli.js` does not already import `fs`/`path`, add at the top:

```js
import fs from "node:fs";
import path from "node:path";
```

In `src/cli.js`, extend the existing import (line 13) and re-export (line 395):

```js
import { exportEntry, migrate, repack, rmCmd } from "./log-cli.js";
```
```js
export { exportEntry, migrate, repack, rmCmd } from "./log-cli.js";
```

Add dispatch in `main()` right after the `migrate` line (currently line 410):

```js
  if (cmd === "repack") { opts.session = rest[1]; return repack(opts); }
  if (cmd === "rm") return rmCmd(rest[1], opts);
```

Add two help lines to the `HELP` string near the existing `migrate` description (line ~33):

```js
  ccglass repack [session]      Re-pack stored captures into the deduped v2 format
  ccglass rm <session>          Delete a session and reclaim its orphaned blobs
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test`
Expected: ALL tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli.js src/log-cli.js test/cli.test.js
git commit -m "feat(cli): add repack and rm subcommands"
```

---

## Task 9: Full suite + README note

**Files:**
- Modify: `README.md` (document `repack`/`rm` and the v2 format briefly)
- Test: full suite

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: all tests pass, 0 failing.

- [ ] **Step 2: Add a short README section**

Find the commands/usage section in `README.md` and add:

```markdown
### Storage format

Captures are stored content-addressed (git-style): each message, the `tools`
array, and the `system` block are written once to `<root>/blobs/` and referenced
by hash from per-request manifests. This keeps long sessions from growing
quadratically. Legacy captures are migrated to this format automatically the
first time they are read.

- `ccglass repack [session]` — force-migrate existing captures now.
- `ccglass rm <session>` — delete a session and reclaim its orphaned blobs.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document content-addressed storage, repack, and rm"
```

---

## Self-Review Notes

- **Spec coverage:** blob store (T1), manifest + lossless pack/unpack (T2), write path (T3), transparent read (T4), auto-migration (T5), O(N) dedup guard (T6), delete-time GC (T7), `repack`/`rm` CLI (T8), docs (T9). All spec sections mapped.
- **Type consistency:** `writeBlob`/`readBlob`/`blobPath`/`blobRef`, `packRecord`/`unpackRecord`, `collectRefs`/`gcBlobs`, `rmSession`, `repack`/`rmCmd` names are used identically across tasks. `readRecordFile(file, id, root)` signature is consistent across its three call sites. Manifest fields (`v`, `request.{headers,meta,historyKey,system,tools,messages}`, `response`) match between pack (T2) and unpack (T2) and GC (`collectRefs`, T7).
- **`gcBlobs` injection:** `gcBlobs(root, listSessions, sessionDir)` takes the lister and dir-builder as args to avoid a store→blobs→store import cycle; `rmSession` supplies them.
- **OpenAI shape:** `historyKey` records `messages` vs `input` so unpack restores under the original key.
