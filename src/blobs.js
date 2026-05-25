// Content-addressed blob store: each unit of request content is written once to
// <root>/blobs/<ab>/<sha256>.json (sharded by the first 2 hex chars, git-style)
// and referenced by "sha256:<hex>". Blobs are immutable / write-once.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export function blobRef(value) {
  // Hashing contract: JSON.stringify is key-order-sensitive, so callers must
  // preserve insertion order for dedup to hit (same content, different key
  // order hashes differently).
  const json = JSON.stringify(value);
  const hex = createHash("sha256").update(json).digest("hex");
  return { ref: `sha256:${hex}`, hex, json };
}

export function blobPath(root, ref) {
  const hex = ref.startsWith("sha256:") ? ref.slice("sha256:".length) : ref;
  return path.join(root, "blobs", hex.slice(0, 2), `${hex}.json`);
}

export function writeBlob(root, value) {
  const { ref, json } = blobRef(value);
  const file = blobPath(root, ref);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, file);
  }
  return ref;
}

export function readBlob(root, ref) {
  return JSON.parse(fs.readFileSync(blobPath(root, ref), "utf8"));
}
