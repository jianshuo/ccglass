import { test } from "node:test";
import assert from "node:assert/strict";
import { statusClass, groupRetries } from "../src/classify.js";

// ---- statusClass ----

test("statusClass: null → pending", () => {
  assert.equal(statusClass(null), "pending");
});

test("statusClass: undefined → pending", () => {
  assert.equal(statusClass(undefined), "pending");
});

test("statusClass: 200 → ok", () => {
  assert.equal(statusClass(200), "ok");
});

test("statusClass: 201 → ok", () => {
  assert.equal(statusClass(201), "ok");
});

test("statusClass: 301 → ok", () => {
  assert.equal(statusClass(301), "ok");
});

test("statusClass: 400 → 4xx", () => {
  assert.equal(statusClass(400), "4xx");
});

test("statusClass: 401 → 4xx", () => {
  assert.equal(statusClass(401), "4xx");
});

test("statusClass: 429 → 4xx", () => {
  assert.equal(statusClass(429), "4xx");
});

test("statusClass: 500 → 5xx", () => {
  assert.equal(statusClass(500), "5xx");
});

test("statusClass: 502 → 5xx", () => {
  assert.equal(statusClass(502), "5xx");
});

// ---- groupRetries ----

test("groupRetries: single entry has empty retries array", () => {
  const entries = [{ url: "/v1/messages", model: "claude-3", nMessages: 3, ts: 1000 }];
  const result = groupRetries(entries);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].retries, []);
});

test("groupRetries: consecutive same url/model/nMessages within 60s are grouped", () => {
  const base = { url: "/v1/messages", model: "claude-3", nMessages: 3 };
  const entries = [
    { ...base, ts: 1000, id: "a" },
    { ...base, ts: 5000, id: "b" },
    { ...base, ts: 10000, id: "c" },
  ];
  const result = groupRetries(entries);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "a");
  assert.equal(result[0].retries.length, 2);
  assert.equal(result[0].retries[0].id, "b");
  assert.equal(result[0].retries[1].id, "c");
});

test("groupRetries: entries outside 60s window start new groups", () => {
  const base = { url: "/v1/messages", model: "claude-3", nMessages: 3 };
  const entries = [
    { ...base, ts: 0, id: "a" },
    { ...base, ts: 61_000, id: "b" },
  ];
  const result = groupRetries(entries);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, "a");
  assert.equal(result[1].id, "b");
});

test("groupRetries: different url starts a new group", () => {
  const entries = [
    { url: "/v1/messages", model: "claude-3", nMessages: 3, ts: 1000, id: "a" },
    { url: "/v1/other", model: "claude-3", nMessages: 3, ts: 2000, id: "b" },
  ];
  const result = groupRetries(entries);
  assert.equal(result.length, 2);
});

test("groupRetries: different model starts a new group", () => {
  const entries = [
    { url: "/v1/messages", model: "claude-3-opus", nMessages: 3, ts: 1000, id: "a" },
    { url: "/v1/messages", model: "claude-3-sonnet", nMessages: 3, ts: 2000, id: "b" },
  ];
  const result = groupRetries(entries);
  assert.equal(result.length, 2);
});

test("groupRetries: different nMessages starts a new group", () => {
  const entries = [
    { url: "/v1/messages", model: "claude-3", nMessages: 3, ts: 1000, id: "a" },
    { url: "/v1/messages", model: "claude-3", nMessages: 5, ts: 2000, id: "b" },
  ];
  const result = groupRetries(entries);
  assert.equal(result.length, 2);
});

test("groupRetries: window extends from last retry timestamp, not first", () => {
  const base = { url: "/v1/messages", model: "claude-3", nMessages: 3 };
  // a → b within 60s, b → c within 60s of b (but c is > 60s after a)
  const entries = [
    { ...base, ts: 0, id: "a" },
    { ...base, ts: 55_000, id: "b" },
    { ...base, ts: 110_000, id: "c" }, // 55s after b, but 110s after a
  ];
  const result = groupRetries(entries);
  // c is within 60s of b (last retry), so all three are in one group
  assert.equal(result.length, 1);
  assert.equal(result[0].retries.length, 2);
  assert.equal(result[0].retries[1].id, "c");
});
