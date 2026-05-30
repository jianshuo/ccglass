// CA certificate management for forward-proxy TLS MITM.
// Generates a root CA (once) and signs per-host certificates on demand.
// Uses openssl CLI to avoid native/npm dependencies.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const CA_KEY = "ca.key";
const CA_CRT = "ca.crt";

/**
 * Ensure a CA key+cert exist under `dir`. Creates them if missing.
 * Returns { key: Buffer, cert: Buffer }.
 */
export function ensureCA(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const keyPath = path.join(dir, CA_KEY);
  const crtPath = path.join(dir, CA_CRT);

  if (!fs.existsSync(keyPath) || !fs.existsSync(crtPath)) {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${crtPath}" ` +
        `-days 825 -nodes -subj "/CN=ccglass CA" 2>/dev/null`,
      { stdio: "pipe" }
    );
  }

  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(crtPath),
  };
}

/**
 * Sign a certificate for `host` using the given CA. Returns { key, cert }
 * buffers. Results are cached in memory for the process lifetime.
 */
const hostCache = new Map();

export function signHost(host, ca) {
  if (hostCache.has(host)) return hostCache.get(host);

  // Generate a key pair in memory, CSR via temp files
  const tmpDir = path.join(os.tmpdir(), `ccglass-cert-${process.pid}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const keyFile = path.join(tmpDir, "host.key");
  const csrFile = path.join(tmpDir, "host.csr");
  const crtFile = path.join(tmpDir, "host.crt");
  const extFile = path.join(tmpDir, "host.ext");
  const caKeyFile = path.join(tmpDir, "ca.key");
  const caCrtFile = path.join(tmpDir, "ca.crt");

  fs.writeFileSync(caKeyFile, ca.key);
  fs.writeFileSync(caCrtFile, ca.cert);
  fs.writeFileSync(extFile, `subjectAltName=DNS:${host}\n`);

  execSync(
    `openssl req -newkey rsa:2048 -keyout "${keyFile}" -out "${csrFile}" ` +
      `-nodes -subj "/CN=${host}" 2>/dev/null`,
    { stdio: "pipe" }
  );
  execSync(
    `openssl x509 -req -in "${csrFile}" -CA "${caCrtFile}" -CAkey "${caKeyFile}" ` +
      `-CAcreateserial -out "${crtFile}" -days 825 -extfile "${extFile}" 2>/dev/null`,
    { stdio: "pipe" }
  );

  const result = {
    key: fs.readFileSync(keyFile),
    cert: fs.readFileSync(crtFile),
  };

  // Cleanup temp files
  for (const f of [keyFile, csrFile, crtFile, extFile, caKeyFile, caCrtFile]) {
    try { fs.unlinkSync(f); } catch {}
  }
  try { fs.rmdirSync(tmpDir); } catch {}

  hostCache.set(host, result);
  return result;
}
