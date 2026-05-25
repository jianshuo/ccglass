import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeBlob, readBlob, blobPath, packRecord, unpackRecord } from "../src/blobs.js";

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-blob-"));

test("writeBlob is content-addressed and dedups identical content", () => {
  const root = tmpRoot();
  const ref1 = writeBlob(root, { role: "user", content: "hi" });
  const ref2 = writeBlob(root, { role: "user", content: "hi" });
  assert.equal(ref1, ref2);
  assert.match(ref1, /^sha256:[0-9a-f]{64}$/);

  const file = blobPath(root, ref1);
  assert.ok(fs.existsSync(file));
  const hex = ref1.slice("sha256:".length);
  assert.equal(path.basename(path.dirname(file)), hex.slice(0, 2));

  const shardDir = path.dirname(file);
  assert.equal(fs.readdirSync(shardDir).filter((f) => f.endsWith(".json")).length, 1);
});

test("readBlob round-trips the stored value", () => {
  const root = tmpRoot();
  const value = { role: "assistant", content: [{ type: "text", text: "x" }] };
  const ref = writeBlob(root, value);
  assert.deepEqual(readBlob(root, ref), value);
});

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
  fs.rmSync(blobPath(root, manifest.request.messages[0]), { force: true });
  const out = unpackRecord(root, manifest);
  assert.deepEqual(out.request.body.messages[0], { __missing_blob: manifest.request.messages[0] });
});

test("pack -> unpack preserves request method and url", () => {
  const root = tmpRoot();
  const rec = makeRec({ model: "m", messages: [{ role: "user", content: "hi" }] });
  rec.request.method = "POST";
  rec.request.url = "/v1/messages";
  const out = unpackRecord(root, packRecord(root, rec));
  assert.equal(out.request.method, "POST");
  assert.equal(out.request.url, "/v1/messages");
  assert.deepEqual(out, rec); // still fully lossless
});
