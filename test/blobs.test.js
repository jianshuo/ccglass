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

  const file = blobPath(root, ref1);
  assert.ok(fs.existsSync(file));
  const hex = ref1.slice("sha256:".length);
  assert.equal(path.basename(path.dirname(file)), hex.slice(0, 2));
});

test("readBlob round-trips the stored value", () => {
  const root = tmpRoot();
  const value = { role: "assistant", content: [{ type: "text", text: "x" }] };
  const ref = writeBlob(root, value);
  assert.deepEqual(readBlob(root, ref), value);
});
