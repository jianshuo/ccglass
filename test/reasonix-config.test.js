import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  reasonixConfigBaseUrl,
  reasonixConfigPath,
  resolveDeepseekBaseUrlEnv,
  resolveReasonixUpstream,
} from "../src/reasonix-config.js";

test("reasonixConfigPath matches Reasonix defaultConfigPath layout", () => {
  const home = "/tmp/fake-home";
  assert.equal(reasonixConfigPath(home), path.join(home, ".reasonix", "config.json"));
});

test("reasonixConfigBaseUrl reads baseUrl from config.json", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-reasonix-"));
  const configPath = reasonixConfigPath(home);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify({ baseUrl: "https://self-hosted.example.com/v1" }),
    "utf8",
  );

  assert.equal(reasonixConfigBaseUrl(home), "https://self-hosted.example.com/v1");
});

test("reasonixConfigBaseUrl strips UTF-8 BOM like Reasonix readConfig", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-reasonix-bom-"));
  const configPath = reasonixConfigPath(home);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `\uFEFF${JSON.stringify({ baseUrl: "https://bom.example.com" })}`,
    "utf8",
  );

  assert.equal(reasonixConfigBaseUrl(home), "https://bom.example.com");
});

test("reasonixConfigBaseUrl returns null when baseUrl is empty", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-reasonix-empty-"));
  const configPath = reasonixConfigPath(home);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ baseUrl: "   " }), "utf8");

  assert.equal(reasonixConfigBaseUrl(home), null);
});

test("resolveDeepseekBaseUrlEnv prefers DEEPSEEK_BASE_URL over DEEPSEEK_API_BASE_URL", () => {
  assert.equal(
    resolveDeepseekBaseUrlEnv({
      DEEPSEEK_BASE_URL: "https://canonical.example.com",
      DEEPSEEK_API_BASE_URL: "https://alias.example.com",
    }),
    "https://canonical.example.com",
  );
});

test("resolveDeepseekBaseUrlEnv accepts DEEPSEEK_API_BASE_URL alias", () => {
  assert.equal(
    resolveDeepseekBaseUrlEnv({ DEEPSEEK_API_BASE_URL: "https://alias.example.com" }),
    "https://alias.example.com",
  );
});

test("resolveReasonixUpstream prefers env over config (Reasonix loadEndpoint)", () => {
  assert.equal(
    resolveReasonixUpstream({
      envUrl: "https://from-env.example.com",
      configUrl: "https://from-config.example.com",
      defaultUrl: "https://api.deepseek.com",
    }),
    "https://from-env.example.com",
  );
});

test("resolveReasonixUpstream falls back to config then default", () => {
  assert.equal(
    resolveReasonixUpstream({
      envUrl: null,
      configUrl: "https://from-config.example.com",
      defaultUrl: "https://api.deepseek.com",
    }),
    "https://from-config.example.com",
  );
  assert.equal(
    resolveReasonixUpstream({
      envUrl: null,
      configUrl: null,
      defaultUrl: "https://api.deepseek.com",
    }),
    "https://api.deepseek.com",
  );
});
