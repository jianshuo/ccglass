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
