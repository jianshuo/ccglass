// Resolve a human-readable session *name* (e.g. "usage-session-name") for a
// captured ccglass session by cross-referencing the coding agent's own
// transcripts. ccglass keys sessions by the proxy's start timestamp, which is
// opaque; Claude Code, by contrast, stores a real title per conversation. We
// recover it by linking each captured request to its Claude Code transcript and
// reading the title out of that transcript.
//
// Link: Claude Code sends `metadata.user_id` on every Anthropic request — a JSON
// string carrying the conversation's `session_id` (a UUID). That UUID is also
// the transcript filename under ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl.
//
// Title precedence inside a transcript (highest first):
//   custom-title  →  customTitle  (user's `/rename`)
//   ai-title      →  aiTitle      (auto-generated summary)
//   first user prompt             (slug-ish fallback)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Claude Code conversation UUID embedded in a captured request, or null. */
export function claudeSessionId(rec) {
  const uid = rec?.request?.body?.metadata?.user_id;
  if (typeof uid !== "string") return null;
  try {
    const sid = JSON.parse(uid).session_id;
    return typeof sid === "string" && sid ? sid : null;
  } catch {
    return null;
  }
}

/**
 * Index of Claude Code transcript UUID → file path, scanned once from
 * ~/.claude/projects/<*>/<uuid>.jsonl. `projectsRoot` is overridable for tests.
 * Returns an empty Map when the directory is absent (no Claude Code installed).
 */
export function buildTranscriptIndex(projectsRoot = defaultProjectsRoot()) {
  const index = new Map();
  let projects;
  try {
    projects = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return index;
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const dir = path.join(projectsRoot, p.name);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith(".jsonl")) index.set(f.slice(0, -6), path.join(dir, f));
    }
  }
  return index;
}

function defaultProjectsRoot() {
  return path.join(os.homedir(), ".claude", "projects");
}

/** First human-typed prompt in a `user` transcript line, trimmed to one line. */
function firstUserText(entry) {
  if (entry.isMeta || entry.isCompactSummary) return null;
  const content = entry.message?.content;
  let text = null;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const blk of content) {
      if (blk?.type === "text" && typeof blk.text === "string") {
        text = blk.text;
        break;
      }
    }
  }
  if (!text) return null;
  text = text.trim();
  // Skip slash-command caveats and tool/command wrappers like
  // `<local-command-...>` or `<command-name>` that aren't real titles.
  if (!text || text.startsWith("<")) return null;
  const firstLine = text.split("\n", 1)[0].trim();
  return firstLine || null;
}

/**
 * Read a Claude Code transcript and return its best title, or null. Walks the
 * whole file so the *last* custom/ai title wins (titles are appended as the
 * conversation evolves); the first real user prompt is the final fallback.
 */
export function titleFromTranscript(file) {
  let data;
  try {
    data = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let custom = null;
  let ai = null;
  let firstPrompt = null;
  for (const line of data.split("\n")) {
    if (!line) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    switch (d.type) {
      case "custom-title":
        if (d.customTitle) custom = d.customTitle;
        break;
      case "ai-title":
        if (d.aiTitle) ai = d.aiTitle;
        break;
      case "user":
        if (firstPrompt == null) {
          const t = firstUserText(d);
          if (t) firstPrompt = t;
        }
        break;
    }
  }
  return custom || ai || firstPrompt || null;
}

/**
 * Best human-readable name for a ccglass session given its records. Picks the
 * dominant Claude Code conversation referenced by the records (sessions usually
 * map 1:1, but a long-lived proxy can span a couple), then reads that
 * transcript's title. Returns null when no Claude Code link or title is found.
 *
 * Pass a shared `cache` (Map<file, title>) across sessions in one rollup so a
 * transcript several ccglass sessions resolve to (a large file, MBs each) is
 * read and parsed once, not once per session.
 */
export function resolveSessionName(records, index, cache) {
  if (!index || index.size === 0) return null;
  const counts = new Map();
  for (const rec of records) {
    const sid = claudeSessionId(rec);
    if (sid) counts.set(sid, (counts.get(sid) || 0) + 1);
  }
  if (counts.size === 0) return null;
  let bestSid = null;
  let bestN = 0;
  for (const [sid, n] of counts) {
    if (n > bestN) {
      bestN = n;
      bestSid = sid;
    }
  }
  const file = index.get(bestSid);
  if (!file) return null;
  if (cache && cache.has(file)) return cache.get(file);
  const title = titleFromTranscript(file);
  if (cache) cache.set(file, title);
  return title;
}
