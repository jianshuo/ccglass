import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(__dirname, "..", "bin", "ccglass.js");

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [bin, ...args], {
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
