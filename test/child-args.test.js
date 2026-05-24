import { test } from "node:test";
import assert from "node:assert/strict";

import { proxyArgs } from "../src/child-args.js";

test("proxyArgs rewrites PowerShell-expanded base_url env values to the proxy", () => {
  const args = ["-c", "model_providers.gaisf_responses.base_url='https://upstream.example/openai'"];

  assert.deepEqual(
    proxyArgs(args, "CODEX_BASE_URL", "http://127.0.0.1:12345", {
      CODEX_BASE_URL: "https://upstream.example/openai",
    }),
    ["-c", "model_providers.gaisf_responses.base_url='http://127.0.0.1:12345'"]
  );
});

test("proxyArgs rewrites literal PowerShell env placeholders to the proxy", () => {
  const args = ["-c", "model_providers.gaisf_responses.base_url='$env:CODEX_BASE_URL'"];

  assert.deepEqual(proxyArgs(args, "CODEX_BASE_URL", "http://127.0.0.1:12345", {}), [
    "-c",
    "model_providers.gaisf_responses.base_url='http://127.0.0.1:12345'",
  ]);
});

test("proxyArgs rewrites explicit upstream URLs in base-url context to the proxy", () => {
  const args = ["-c", "model_providers.gaisf_responses.base_url='https://upstream.example/openai'"];

  assert.deepEqual(
    proxyArgs(args, "CODEX_BASE_URL", "http://127.0.0.1:12345", {}, "https://upstream.example/openai"),
    ["-c", "model_providers.gaisf_responses.base_url='http://127.0.0.1:12345'"]
  );
});

test("proxyArgs rewrites cmd env placeholders to the proxy", () => {
  const args = ["--base-url", "%CODEX_BASE_URL%"];

  assert.deepEqual(proxyArgs(args, "CODEX_BASE_URL", "http://127.0.0.1:12345", {}), [
    "--base-url",
    "http://127.0.0.1:12345",
  ]);
});

test("proxyArgs uses the selected provider env var, not a Codex-specific name", () => {
  const args = ["--base-url", "$env:MY_CUSTOM_BASE_URL"];

  assert.deepEqual(proxyArgs(args, "MY_CUSTOM_BASE_URL", "http://127.0.0.1:12345", {}), [
    "--base-url",
    "http://127.0.0.1:12345",
  ]);
});

test("proxyArgs does not rewrite unrelated upstream mentions outside base-url context", () => {
  const args = ["--prompt", "open https://upstream.example/openai in a browser"];

  assert.deepEqual(
    proxyArgs(args, "CODEX_BASE_URL", "http://127.0.0.1:12345", {
      CODEX_BASE_URL: "https://upstream.example/openai",
    }),
    args
  );
});