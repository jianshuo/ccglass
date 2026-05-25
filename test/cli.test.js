import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(__dirname, "..", "bin", "ccglass.js");

function run(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], {
      env: { ...process.env, ...env },
      timeout: 5000,
    }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout, stderr });
    });
  });
}

test("opencode exits with code 1 and a clear error when OPENAI_BASE_URL is unset", async () => {
  const env = { ...process.env };
  delete env.OPENAI_BASE_URL;

  const { code, stderr } = await run(["opencode"], env);

  assert.equal(code, 1);
  assert.match(stderr, /OpenCode/);
  assert.match(stderr, /OPENAI_BASE_URL/);
  assert.match(stderr, /--upstream/);
});

test("opencode exits with code 1 and a clear error when OPENAI_BASE_URL is empty", async () => {
  const { code, stderr } = await run(["opencode"], { OPENAI_BASE_URL: "" });

  assert.equal(code, 1);
  assert.match(stderr, /OpenCode/);
  assert.match(stderr, /OPENAI_BASE_URL/);
});

test("codex-azure exits with code 1 and a clear error when AZURE_OPENAI_ENDPOINT is unset", async () => {
  const env = { ...process.env };
  delete env.AZURE_OPENAI_ENDPOINT;

  const { code, stderr } = await run(["codex-azure"], env);

  assert.equal(code, 1);
  assert.match(stderr, /Codex \(Azure OpenAI\)/);
  assert.match(stderr, /AZURE_OPENAI_ENDPOINT/);
  assert.match(stderr, /--upstream/);
});

test("bedrock keys off ANTHROPIC_BEDROCK_BASE_URL, not ANTHROPIC_BASE_URL", async () => {
  // Regression test for the silent-bypass bug: in Bedrock mode, Claude Code
  // reads ANTHROPIC_BEDROCK_BASE_URL. If ccglass injects ANTHROPIC_BASE_URL,
  // the child silently ignores it and the proxy captures nothing. Setting only
  // ANTHROPIC_BASE_URL must NOT be enough to satisfy the bedrock provider, and
  // the missing-var error must name the correct key so users can fix it.
  // Note: run() does `{ ...process.env, ...env }`, so `delete env.X` won't
  // remove X when the caller's environment has it set. Use an empty-string
  // override to actually clear it for the child.
  const env = {
    ANTHROPIC_BEDROCK_BASE_URL: "",
    ANTHROPIC_BASE_URL: "https://api.anthropic.com",
  };

  const { code, stderr } = await run(["bedrock"], env);

  assert.equal(code, 1);
  assert.match(stderr, /AWS Bedrock/);
  assert.match(stderr, /ANTHROPIC_BEDROCK_BASE_URL/);
  assert.doesNotMatch(stderr, /Set ANTHROPIC_BASE_URL/);
});

test("claude uses ANTHROPIC_BASE_URL env var as upstream (invalid URL triggers clear error)", async () => {
  const { code, stderr } = await run(["claude"], { ANTHROPIC_BASE_URL: "not-a-valid-url" });

  assert.equal(code, 1);
  assert.match(stderr, /invalid upstream URL/);
  assert.match(stderr, /ANTHROPIC_BASE_URL/);
});

test("--version flag prints version and exits 0", async () => {
  const { code, stdout } = await run(["--version"]);

  assert.equal(code, 0);
  assert.match(stdout, /^\d+\.\d+\.\d+/);
});

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

test("ccglass repack migrates a legacy v1 capture to v2", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-repackcli-"));
  const session = "2020-03-03T00-00-00-000Z";
  const dir = path.join(root, session);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "0001.json");
  fs.writeFileSync(file, JSON.stringify({
    id: `${session}/0001`, session, seq: 1, ts: 1, format: "anthropic",
    request: { headers: {}, body: { model: "m", messages: [{ role: "user", content: "hi" }], tools: [] } },
    response: { status: 200 },
  }));
  const { code } = await run(["repack", "--dir", root]);
  assert.equal(code, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).v, 2);
});

