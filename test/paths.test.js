import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  projectKey,
  encodeFullPath,
  globalRoot,
  legacyRoot,
  canonicalRoot,
  readRoots,
} from "../src/paths.js";

test("projectKey encodes full path and keeps Unicode", () => {
  const cwd = "/Users/you/项目A";
  const key = projectKey(cwd);
  assert.equal(key, projectKey(path.resolve(cwd)));
  assert.ok(key.includes("项目A"));
  assert.match(key, /-[a-f0-9]{8}$/);
  assert.ok(key.startsWith(encodeFullPath(cwd) + "-"));
});

test("encodeFullPath differs for different resolved paths", () => {
  assert.notEqual(encodeFullPath("/foo/bar"), encodeFullPath("/foo/baz"));
});

test("globalRoot lives under ~/.ccglass/sessions/<encoded-path-hash>", () => {
  const cwd = "/tmp/my-project";
  const root = globalRoot(cwd);
  assert.ok(root.endsWith(projectKey(cwd)));
});

test("legacyRoot is ./.ccglass under cwd", () => {
  assert.equal(legacyRoot("/work/repo"), path.join("/work/repo", ".ccglass"));
});

test("readRoots dedupes when --dir points at legacy", () => {
  const cwd = "/proj";
  const legacy = path.resolve(legacyRoot(cwd));
  const roots = readRoots(legacy, cwd);
  assert.deepEqual(roots, [legacy]);
});

test("readRoots includes global and project legacy", () => {
  const cwd = "/proj";
  const global = path.resolve(globalRoot(cwd));
  const legacy = path.resolve(legacyRoot(cwd));
  const roots = readRoots(global, cwd);
  assert.deepEqual(roots, [global, legacy]);
});

test("readRoots dedupes symlink-equivalent write dir and legacy", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-sym-"));
  const real = path.join(base, "real");
  const link = path.join(base, "link");
  fs.mkdirSync(real);
  fs.mkdirSync(path.join(real, ".ccglass"));
  fs.symlinkSync(real, link, "dir");

  const legacyPath = path.join(link, ".ccglass");
  const roots = readRoots(legacyPath, link);
  const glassRoots = roots.filter((r) => r.endsWith(".ccglass"));
  assert.equal(glassRoots.length, 1);
  assert.equal(glassRoots[0], canonicalRoot(path.join(real, ".ccglass")));

  fs.rmSync(base, { recursive: true, force: true });
});

test("canonicalRoot resolves through symlink parent when leaf is missing", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-can-"));
  const real = path.join(base, "real");
  const link = path.join(base, "link");
  fs.mkdirSync(real);
  fs.mkdirSync(path.join(real, ".ccglass"));
  fs.symlinkSync(real, link, "dir");

  const viaLink = path.join(link, ".ccglass");
  const viaReal = path.join(real, ".ccglass");
  const canonical = canonicalRoot(viaReal);
  assert.equal(canonicalRoot(viaLink), canonical);
  assert.equal(canonicalRoot(viaReal), canonical);

  fs.rmSync(base, { recursive: true, force: true });
});
