import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureCA, signHost } from "../src/ca.js";

test("ensureCA creates CA key and cert", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-ca-test-"));
  try {
    const ca = ensureCA(dir);
    assert.ok(Buffer.isBuffer(ca.key), "key should be a Buffer");
    assert.ok(Buffer.isBuffer(ca.cert), "cert should be a Buffer");
    assert.ok(ca.key.toString().includes("PRIVATE KEY"), "key should be PEM");
    assert.ok(ca.cert.toString().includes("CERTIFICATE"), "cert should be PEM");

    // Files should exist
    assert.ok(fs.existsSync(path.join(dir, "ca.key")));
    assert.ok(fs.existsSync(path.join(dir, "ca.crt")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureCA is idempotent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-ca-test-"));
  try {
    const ca1 = ensureCA(dir);
    const ca2 = ensureCA(dir);
    assert.deepEqual(ca1.key, ca2.key, "key should be the same on second call");
    assert.deepEqual(ca1.cert, ca2.cert, "cert should be the same on second call");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("signHost generates a cert for the given host", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-ca-test-"));
  try {
    const ca = ensureCA(dir);
    const hostCert = signHost("example.com", ca);
    assert.ok(Buffer.isBuffer(hostCert.key), "host key should be a Buffer");
    assert.ok(Buffer.isBuffer(hostCert.cert), "host cert should be a Buffer");
    assert.ok(hostCert.key.toString().includes("PRIVATE KEY"));
    assert.ok(hostCert.cert.toString().includes("CERTIFICATE"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("signHost caches results for the same host", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-ca-test-"));
  try {
    const ca = ensureCA(dir);
    const cert1 = signHost("cached.example.com", ca);
    const cert2 = signHost("cached.example.com", ca);
    assert.strictEqual(cert1, cert2, "should return the same object from cache");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
