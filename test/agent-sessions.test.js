import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claudeSessionId,
  buildTranscriptIndex,
  titleFromTranscript,
  resolveSessionName,
} from "../src/agent-sessions.js";

function mkProjectsRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ccglass-agentsess-"));
}

// Write a transcript file under <root>/<project>/<uuid>.jsonl from an array of
// JSON-able entries (one per line), the way Claude Code persists conversations.
function writeTranscript(root, project, uuid, entries) {
  const dir = path.join(root, project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${uuid}.jsonl`);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

// A captured ccglass record carrying Claude Code's session linkage. user_id is a
// JSON *string* (as the proxy stores it) holding the conversation UUID.
function recWithSession(sessionUuid) {
  return {
    request: {
      body: {
        metadata: { user_id: JSON.stringify({ device_id: "d", account_uuid: "a", session_id: sessionUuid }) },
      },
    },
  };
}

test("claudeSessionId parses session_id from metadata.user_id", () => {
  assert.equal(claudeSessionId(recWithSession("abc-123")), "abc-123");
});

test("claudeSessionId returns null when linkage is absent or malformed", () => {
  assert.equal(claudeSessionId({}), null);
  assert.equal(claudeSessionId({ request: { body: {} } }), null);
  assert.equal(claudeSessionId({ request: { body: { metadata: { user_id: "not json" } } } }), null);
  assert.equal(claudeSessionId({ request: { body: { metadata: { user_id: JSON.stringify({}) } } } }), null);
});

test("titleFromTranscript prefers custom-title over ai-title and prompt", () => {
  const root = mkProjectsRoot();
  const file = writeTranscript(root, "proj", "u1", [
    { type: "user", message: { content: "first real prompt here" } },
    { type: "ai-title", aiTitle: "Auto Generated Title" },
    { type: "custom-title", customTitle: "my-renamed-session" },
  ]);
  assert.equal(titleFromTranscript(file), "my-renamed-session");
  fs.rmSync(root, { recursive: true, force: true });
});

test("titleFromTranscript falls back to ai-title, then to first user prompt", () => {
  const root = mkProjectsRoot();
  const aiFile = writeTranscript(root, "proj", "u2", [
    { type: "user", message: { content: "the prompt" } },
    { type: "ai-title", aiTitle: "Auto Title" },
  ]);
  assert.equal(titleFromTranscript(aiFile), "Auto Title");

  const promptFile = writeTranscript(root, "proj", "u3", [
    // meta/command lines must be skipped — only a real prompt becomes the title.
    { type: "user", isMeta: true, message: { content: "meta noise" } },
    { type: "user", message: { content: "<local-command-stdout>ignored</local-command-stdout>" } },
    { type: "user", message: { content: [{ type: "text", text: "actual question\nsecond line" }] } },
  ]);
  assert.equal(titleFromTranscript(promptFile), "actual question");
  fs.rmSync(root, { recursive: true, force: true });
});

test("titleFromTranscript returns last custom-title when renamed twice", () => {
  const root = mkProjectsRoot();
  const file = writeTranscript(root, "proj", "u4", [
    { type: "custom-title", customTitle: "first-name" },
    { type: "user", message: { content: "work" } },
    { type: "custom-title", customTitle: "second-name" },
  ]);
  assert.equal(titleFromTranscript(file), "second-name");
  fs.rmSync(root, { recursive: true, force: true });
});

test("buildTranscriptIndex maps every uuid across projects; empty when missing", () => {
  const root = mkProjectsRoot();
  writeTranscript(root, "projA", "uuid-a", [{ type: "user", message: { content: "a" } }]);
  writeTranscript(root, "projB", "uuid-b", [{ type: "user", message: { content: "b" } }]);
  const index = buildTranscriptIndex(root);
  assert.equal(index.size, 2);
  assert.ok(index.get("uuid-a").endsWith(path.join("projA", "uuid-a.jsonl")));
  assert.ok(index.get("uuid-b").endsWith(path.join("projB", "uuid-b.jsonl")));

  assert.equal(buildTranscriptIndex(path.join(root, "does-not-exist")).size, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("resolveSessionName links records to the dominant transcript's title", () => {
  const root = mkProjectsRoot();
  writeTranscript(root, "proj", "sess-main", [{ type: "custom-title", customTitle: "feature-all-token" }]);
  writeTranscript(root, "proj", "sess-other", [{ type: "custom-title", customTitle: "stray" }]);
  const index = buildTranscriptIndex(root);

  // 3 records point at sess-main, 1 at sess-other → dominant wins.
  const records = [
    recWithSession("sess-main"),
    recWithSession("sess-main"),
    recWithSession("sess-other"),
    recWithSession("sess-main"),
  ];
  assert.equal(resolveSessionName(records, index), "feature-all-token");
  fs.rmSync(root, { recursive: true, force: true });
});

test("resolveSessionName caches per-file so a shared transcript is read once", () => {
  const root = mkProjectsRoot();
  const file = writeTranscript(root, "proj", "sess-shared", [{ type: "custom-title", customTitle: "shared-name" }]);
  const index = buildTranscriptIndex(root);
  const cache = new Map();

  const a = resolveSessionName([recWithSession("sess-shared")], index, cache);
  // Delete the file: a second resolve must still succeed from cache, proving the
  // first read was memoised rather than re-read.
  fs.rmSync(file);
  const b = resolveSessionName([recWithSession("sess-shared")], index, cache);

  assert.equal(a, "shared-name");
  assert.equal(b, "shared-name");
  fs.rmSync(root, { recursive: true, force: true });
});

test("resolveSessionName returns null without linkage or transcript", () => {
  const root = mkProjectsRoot();
  const index = buildTranscriptIndex(root); // empty
  assert.equal(resolveSessionName([recWithSession("x")], index), null);
  assert.equal(resolveSessionName([{}], buildTranscriptIndex(root)), null);
  fs.rmSync(root, { recursive: true, force: true });
});
