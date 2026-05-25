import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ENCODED_MAX = 240;

function hashSuffix(resolved) {
  return crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 8);
}

/** Filesystem-safe encoding of the full resolved path (keeps Unicode). */
export function encodeFullPath(cwd) {
  let s = path.resolve(cwd);
  if (process.platform === "win32") s = s.replace(/^([A-Za-z]):/, "$1-");
  s = s.replace(/[/\\]/g, "--");
  s = s.replace(/[<>:"|?*\x00-\x1f]/g, "_");
  s = s.replace(/^--+/, "");
  if (!s) s = "root";
  if (s.length > ENCODED_MAX) s = s.slice(0, ENCODED_MAX).replace(/--$/, "");
  return s;
}

/** Directory name: full encoded path + hash suffix. */
export function projectKey(cwd) {
  const resolved = path.resolve(cwd);
  return `${encodeFullPath(resolved)}-${hashSuffix(resolved)}`;
}

export function globalRoot(cwd) {
  return path.join(os.homedir(), ".ccglass", "sessions", projectKey(cwd));
}

export function legacyRoot(cwd) {
  return path.join(cwd, ".ccglass");
}

/** Canonical path for dedup; resolves symlinks via nearest existing ancestor. */
export function canonicalRoot(p) {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch (err) {
    if (err?.code !== "ENOENT") return resolved;
    const tail = [];
    let dir = resolved;
    while (true) {
      const base = path.basename(dir);
      if (base && base !== ".") tail.unshift(base);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
      try {
        return path.join(fs.realpathSync.native(dir), ...tail);
      } catch (e) {
        if (e?.code !== "ENOENT") break;
      }
    }
    return resolved;
  }
}

/** Write dir plus project-local ./.ccglass (realpath-deduped). */
export function readRoots(writeDir, cwd = process.cwd()) {
  const candidates = [writeDir, legacyRoot(cwd)];
  const seen = new Set();
  const roots = [];
  for (const p of candidates) {
    const canonical = canonicalRoot(p);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    roots.push(canonical);
  }
  return roots;
}
