import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrate, exportEntry } from "../src/log-cli.js";
import { hasCapturedLogs } from "../src/store.js";

function withExit(fn) {
  let code = 0;
  const stderr = [];
  const origExit = process.exit;
  const origWrite = process.stderr.write;
  process.exit = (c) => {
    code = c ?? 0;
    throw new Error("exit");
  };
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  try {
    fn();
  } catch (e) {
    if (e.message !== "exit") throw e;
  } finally {
    process.exit = origExit;
    process.stderr.write = origWrite;
  }
  return { code, stderr: stderr.join("") };
}

test("exportEntry errors when id is missing", () => {
  const { code, stderr } = withExit(() =>
    exportEntry(null, { readRoots: [], dir: "/tmp" }),
  );
  assert.equal(code, 1);
  assert.match(stderr, /missing entry id/i);
});

test("migrate copies legacy json into dest", () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-mig-fn-"));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-mig-fn-d-"));
  const session = "2026-05-25T12-00-00-000Z";
  const legacyDir = path.join(proj, ".ccglass", session);
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacyDir, "0001.json"),
    JSON.stringify({
      id: `${session}/0001`,
      session,
      seq: 1,
      ts: 1,
      request: {},
      response: { status: 200 },
    }),
  );

  const cwd = process.cwd();
  process.chdir(proj);
  try {
    const { code, stderr } = withExit(() => migrate({ dir: dest }));
    assert.equal(code, 0);
    assert.match(stderr, /copied 1 file/);
    assert.ok(fs.existsSync(path.join(dest, session, "0001.json")));
  } finally {
    process.chdir(cwd);
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test("migrate exits 1 when legacy has no json logs", () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-mig-empty-"));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-mig-empty-d-"));
  fs.mkdirSync(path.join(proj, ".ccglass", "2026-05-25T12-00-00-000Z"), { recursive: true });
  assert.equal(hasCapturedLogs(path.join(proj, ".ccglass")), false);

  const cwd = process.cwd();
  process.chdir(proj);
  try {
    const { code, stderr } = withExit(() => migrate({ dir: dest }));
    assert.equal(code, 1);
    assert.match(stderr, /no \.json logs/i);
  } finally {
    process.chdir(cwd);
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});
