import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { prepareSpawn, resolveWindowsCommand } from "../src/spawn-command.js";

function tempCommand(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-spawn-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, "");
  return { dir, file };
}

test("prepareSpawn leaves native commands unchanged off Windows", () => {
  const prepared = prepareSpawn("codex", ["-c", "x"], {}, "linux");
  assert.deepEqual(prepared, { command: "codex", args: ["-c", "x"] });
});

test("resolveWindowsCommand finds PATHEXT shims on PATH", () => {
  const { dir, file } = tempCommand("codex.cmd");
  const env = { PATH: dir, PATHEXT: ".EXE;.CMD" };

  assert.equal(resolveWindowsCommand("codex", env, "win32"), file);
});

test("prepareSpawn runs Windows cmd shims through cmd.exe", () => {
  const { dir, file } = tempCommand("codex.cmd");
  const env = { PATH: dir, PATHEXT: ".EXE;.CMD", ComSpec: "C:\\Windows\\System32\\cmd.exe" };

  const prepared = prepareSpawn(
    "codex",
    ["-c", "model_providers.gaisf_responses.base_url='%CODEX_BASE_URL%'"],
    env,
    "win32"
  );

  assert.equal(prepared.command, env.ComSpec);
  assert.deepEqual(prepared.args.slice(0, 2), ["/d", "/c"]);
  assert.equal(prepared.windowsVerbatimArguments, true);
  assert.match(prepared.args[2], new RegExp(`^call "${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" `));
  assert.match(prepared.args[2], /"model_providers\.gaisf_responses\.base_url='%CODEX_BASE_URL%'"/);
});

test("prepareSpawn runs PowerShell shims through powershell.exe", () => {
  const { dir, file } = tempCommand("codex.ps1");
  const env = { PATH: dir, PATHEXT: ".EXE" };

  const prepared = prepareSpawn("codex", ["--version"], env, "win32");

  assert.equal(prepared.command, "powershell.exe");
  assert.deepEqual(prepared.args, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, "--version"]);
});