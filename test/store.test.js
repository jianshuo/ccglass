import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Store,
  listSessions,
  loadSession,
  listSessionsMulti,
  loadSessionMulti,
  readEntryById,
  readEntryByIdMulti,
  hasCapturedLogs,
  parseEntryId,
  localTimestamp,
} from "../src/store.js";

test("Store masks auth, persists, and reloads from disk", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-"));
  const store = new Store({ root });

  const rec = store.add({
    request: {
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: "Bearer sk-ant-oat01-SECRETSECRETSECRET-TAIL" },
      body: { model: "claude-opus-4-7", messages: [], tools: [] },
    },
  });
  rec.response = { status: 200, raw: 'data: {"type":"message_stop"}' };
  store.update(rec);

  // masked in memory + on disk
  assert.match(rec.request.headers.authorization, /REDACTED/);

  const sessions = listSessions(root);
  assert.equal(sessions.length, 1);
  const loaded = loadSession(root, sessions[0]);
  assert.equal(loaded.length, 1);
  assert.match(loaded[0].request.headers.authorization, /REDACTED/);
  assert.equal(loaded[0].response.status, 200);

  fs.rmSync(root, { recursive: true, force: true });
});

test("listSessionsMulti merges roots and sorts newest session first", () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-a-"));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-b-"));
  const oldSession = "2020-01-01T00-00-00-000Z";
  const newSession = "2026-05-25T12-00-00-000Z";

  fs.mkdirSync(path.join(a, oldSession), { recursive: true });
  fs.mkdirSync(path.join(b, newSession), { recursive: true });

  const sessions = listSessionsMulti([a, b]);
  assert.deepEqual(sessions, [newSession, oldSession]);

  fs.rmSync(a, { recursive: true, force: true });
  fs.rmSync(b, { recursive: true, force: true });
});

test("loadSessionMulti merges entries from both roots by ts", () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-ma-"));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-mb-"));
  const session = "2026-05-25T12-00-00-000Z";
  const dirA = path.join(a, session);
  const dirB = path.join(b, session);
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });

  const rec1 = {
    id: `${session}/0001`,
    session,
    seq: 1,
    ts: 100,
    request: { method: "POST", url: "/v1/messages", headers: {}, body: {} },
    response: { status: 200 },
  };
  const rec2 = {
    id: `${session}/0002`,
    session,
    seq: 2,
    ts: 200,
    request: { method: "POST", url: "/v1/messages", headers: {}, body: {} },
    response: { status: 200 },
  };
  fs.writeFileSync(path.join(dirA, "0001.json"), JSON.stringify(rec1));
  fs.writeFileSync(path.join(dirB, "0002.json"), JSON.stringify(rec2));

  const merged = loadSessionMulti([a, b], session);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, rec1.id);
  assert.equal(merged[1].id, rec2.id);

  fs.rmSync(a, { recursive: true, force: true });
  fs.rmSync(b, { recursive: true, force: true });
});

test("hasCapturedLogs ignores empty session directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-empty-"));
  const session = "2026-05-25T12-00-00-000Z";
  fs.mkdirSync(path.join(root, session), { recursive: true });
  assert.equal(hasCapturedLogs(root), false);
  fs.writeFileSync(
    path.join(root, session, "0001.json"),
    JSON.stringify({ id: `${session}/0001`, session, seq: 1, ts: 1, request: {}, response: null }),
  );
  assert.equal(hasCapturedLogs(root), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("loadSessionMulti keeps first root on equal ts and older mtime", () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-tie-a-"));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-tie-b-"));
  const session = "2026-05-25T12-00-00-000Z";
  const dirA = path.join(a, session);
  const dirB = path.join(b, session);
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });

  const id = `${session}/0001`;
  const globalRec = {
    id,
    session,
    seq: 1,
    ts: 100,
    request: { method: "POST", url: "/v1/messages", headers: {}, body: { model: "global" } },
    response: { status: 200 },
  };
  const legacyRec = { ...globalRec, request: { ...globalRec.request, body: { model: "legacy" } } };
  fs.writeFileSync(path.join(dirA, "0001.json"), JSON.stringify(globalRec));
  fs.writeFileSync(path.join(dirB, "0001.json"), JSON.stringify(legacyRec));
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(dirB, "0001.json"), past, past);

  const merged = loadSessionMulti([a, b], session);
  assert.equal(merged[0].request.body.model, "global");

  fs.rmSync(a, { recursive: true, force: true });
  fs.rmSync(b, { recursive: true, force: true });
});

test("loadSessionMulti picks newer file on equal ts (e.g. edited legacy)", () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-edit-a-"));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-edit-b-"));
  const session = "2026-05-25T12-00-00-000Z";
  const dirA = path.join(a, session);
  const dirB = path.join(b, session);
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });

  const id = `${session}/0001`;
  const stale = {
    id,
    session,
    seq: 1,
    ts: 100,
    request: { method: "POST", url: "/v1/messages", headers: {}, body: {} },
    response: null,
  };
  const fixed = { ...stale, response: { status: 200, raw: "ok" } };
  fs.writeFileSync(path.join(dirA, "0001.json"), JSON.stringify(stale));
  fs.writeFileSync(path.join(dirB, "0001.json"), JSON.stringify(fixed));
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(dirA, "0001.json"), past, past);

  const merged = loadSessionMulti([a, b], session);
  assert.equal(merged[0].response?.status, 200);

  fs.rmSync(a, { recursive: true, force: true });
  fs.rmSync(b, { recursive: true, force: true });
});

test("loadSessionMulti prefers higher ts even when mtime is older", () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-ts-a-"));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-ts-b-"));
  const session = "2026-05-25T12-00-00-000Z";
  const dirA = path.join(a, session);
  const dirB = path.join(b, session);
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });

  const id = `${session}/0001`;
  const stale = {
    id,
    session,
    seq: 1,
    ts: 100,
    request: { method: "POST", url: "/v1/messages", headers: {}, body: { model: "stale" } },
    response: null,
  };
  const newer = { ...stale, ts: 200, request: { ...stale.request, body: { model: "new" } } };
  fs.writeFileSync(path.join(dirA, "0001.json"), JSON.stringify(stale));
  fs.writeFileSync(path.join(dirB, "0001.json"), JSON.stringify(newer));
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(dirB, "0001.json"), past, past);

  const merged = loadSessionMulti([a, b], session);
  assert.equal(merged[0].request.body.model, "new");

  fs.rmSync(a, { recursive: true, force: true });
  fs.rmSync(b, { recursive: true, force: true });
});

test("loadSessionMulti normalizes id from filename", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-key-"));
  const session = "2026-05-25T12-00-00-000Z";
  const dir = path.join(root, session);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "0001.json"),
    JSON.stringify({
      id: "wrong/id",
      session,
      seq: 1,
      ts: 1,
      request: {},
      response: null,
    }),
  );

  const merged = loadSessionMulti([root], session);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, `${session}/0001`);

  fs.rmSync(root, { recursive: true, force: true });
});

test("loadSessionMulti skips corrupt json files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-bad-json-"));
  const session = "2026-05-25T12-00-00-000Z";
  const dir = path.join(root, session);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "0001.json"), "{ not valid json");
  fs.writeFileSync(
    path.join(dir, "0002.json"),
    JSON.stringify({
      id: `${session}/0002`,
      session,
      seq: 2,
      ts: 2,
      request: {},
      response: null,
    }),
  );

  const merged = loadSessionMulti([root], session);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, `${session}/0002`);

  fs.rmSync(root, { recursive: true, force: true });
});

test("loadSession skips corrupt json files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-bad-load-"));
  const session = "2026-05-25T12-00-00-000Z";
  const dir = path.join(root, session);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "0001.json"), "{ not-json");
  fs.writeFileSync(
    path.join(dir, "0002.json"),
    JSON.stringify({
      id: `${session}/0002`,
      session,
      seq: 2,
      ts: 2,
      request: {},
      response: null,
    }),
  );

  const loaded = loadSession(root, session);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, `${session}/0002`);

  fs.rmSync(root, { recursive: true, force: true });
});

test("parseEntryId rejects malformed ids", () => {
  assert.equal(parseEntryId("no-slash"), null);
  assert.equal(parseEntryId("/only-seq"), null);
  assert.equal(parseEntryId("session-only/"), null);
  assert.deepEqual(parseEntryId("sess/0001"), { session: "sess", seq: "0001" });
});

test("readEntryById returns null for malformed id", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-bad-id-"));
  assert.equal(readEntryById(root, "not-valid"), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("readEntryByIdMulti prefers the newer duplicate across roots", () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-ra-"));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-rb-"));
  const session = "2026-05-25T12-00-00-000Z";
  const dirA = path.join(a, session);
  const dirB = path.join(b, session);
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });

  const id = `${session}/0001`;
  const older = {
    id,
    session,
    seq: 1,
    ts: 100,
    request: { method: "POST", url: "/v1/messages", headers: {}, body: { model: "old" } },
    response: null,
  };
  const newer = { ...older, ts: 300, request: { ...older.request, body: { model: "new" } } };
  fs.writeFileSync(path.join(dirA, "0001.json"), JSON.stringify(older));
  fs.writeFileSync(path.join(dirB, "0001.json"), JSON.stringify(newer));

  const rec = readEntryByIdMulti([a, b], id);
  assert.equal(rec.request.body.model, "new");

  fs.rmSync(a, { recursive: true, force: true });
  fs.rmSync(b, { recursive: true, force: true });
});

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

  const seqFile = path.join(root, store.sessionId, "0001.json");
  const onDisk = JSON.parse(fs.readFileSync(seqFile, "utf8"));
  assert.equal(onDisk.v, 2);
  assert.ok(Array.isArray(onDisk.request.messages));
  assert.match(onDisk.request.messages[0], /^sha256:/);
  assert.equal(onDisk.request.body, undefined);

  assert.deepEqual(rec.request.body.messages, [{ role: "user", content: "hi" }]);

  assert.ok(fs.existsSync(path.join(root, "blobs")));
});

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
  const loaded = loadSession(root, session);
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0].request.body.messages, [{ role: "user", content: "hi" }]);
  assert.deepEqual(loaded[0].request.body.system, [{ type: "text", text: "s" }]);
  assert.deepEqual(loaded[0].request.body.tools, [{ name: "t" }]);

  const one = readEntryById(root, `${session}/0001`);
  assert.equal(one.response.status, 200);
  assert.deepEqual(one.request.body.messages, [{ role: "user", content: "hi" }]);
});

test("listSessions ignores the blobs directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-ls-"));
  const store = new Store({ root });
  const rec = store.add({ request: { method: "POST", url: "/x", headers: {},
    body: { model: "m", messages: [{ role: "user", content: "hi" }], tools: [] } } });
  rec.response = { status: 200 }; store.update(rec);
  const sessions = listSessions(root); // listSessions must already be imported at top of file
  assert.deepEqual(sessions, [store.sessionId]); // NOT ["blobs", ...]
});

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

  const loaded = loadSession(root, session);
  assert.deepEqual(loaded[0].request.body.messages, [{ role: "user", content: "hi" }]);
  const afterFirst = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(afterFirst.v, 2);

  const reloaded = loadSession(root, session);
  assert.deepEqual(reloaded[0].request.body.messages, [{ role: "user", content: "hi" }]);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).v, 2);
});

test("a corrupt v2 manifest yields null, not a thrown error", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-corrupt-"));
  const session = "2020-02-02T00-00-00-000Z";
  const dir = path.join(root, session);
  fs.mkdirSync(dir, { recursive: true });
  // historyKey set but messages is a non-array → (messages||[]).map throws inside unpackRecord
  fs.writeFileSync(path.join(dir, "0001.json"), JSON.stringify({
    v: 2, id: `${session}/0001`, session, seq: 1, ts: 1, format: "anthropic",
    request: { headers: {}, meta: { model: "m" }, historyKey: "messages", system: null, tools: null, messages: "not-an-array" },
    response: null,
  }));
  const loaded = loadSession(root, session); // (use whatever name loadSession is imported as)
  assert.equal(loaded.length, 0); // corrupt entry is dropped (readRecordFile returned null), not thrown
});

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

test("Store.sessionId uses local time format without Z suffix", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-localtime-"));
  const store = new Store({ root });
  // Format: YYYY-MM-DDTHH-MM-SS-MMM (no Z, no offset)
  assert.match(store.sessionId, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}$/);
  assert.doesNotMatch(store.sessionId, /Z$/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("localTimestamp returns local time format without Z suffix", () => {
  const ts = localTimestamp(1700000000000); // fixed epoch ms
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}$/);
  assert.doesNotMatch(ts, /Z$/);
});
