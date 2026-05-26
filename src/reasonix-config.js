// Reasonix stores API endpoint overrides in ~/.reasonix/config.json (see
// DeepSeek-Reasonix src/config.ts defaultConfigPath). ccglass reads baseUrl so
// the proxy forwards to the same upstream the CLI would use without ccglass.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function reasonixConfigPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".reasonix", "config.json");
}

export function reasonixConfigBaseUrl(homeDir = os.homedir()) {
  const configPath = reasonixConfigPath(homeDir);
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
    const cfg = JSON.parse(raw);
    const url = typeof cfg?.baseUrl === "string" ? cfg.baseUrl.trim() : "";
    return url || null;
  } catch {
    return null;
  }
}

export function resolveDeepseekBaseUrlEnv(env = process.env) {
  const url = env.DEEPSEEK_BASE_URL || env.DEEPSEEK_API_BASE_URL;
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  return trimmed || null;
}

// Match Reasonix loadEndpoint: env baseUrl wins over ~/.reasonix/config.json.
export function resolveReasonixUpstream({ envUrl, configUrl, defaultUrl }) {
  return envUrl || configUrl || defaultUrl;
}
