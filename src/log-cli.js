import fs from "node:fs";
import path from "node:path";
import { legacyRoot } from "./paths.js";
import { listSessions, hasCapturedLogs, readEntryByIdMulti, rmSession, loadSession } from "./store.js";
import { renderExport } from "./export.js";
import { summarizeUsage } from "./usage.js";

export function exportEntry(id, opts) {
  if (!id) {
    process.stderr.write("ccglass export: missing entry id. Usage: ccglass export <session>/<seq>\n");
    process.exit(1);
  }
  const rec = readEntryByIdMulti(opts.readRoots, id);
  if (!rec) {
    process.stderr.write(`ccglass: no entry ${id}\n`);
    process.exit(1);
  }
  process.stdout.write(renderExport(rec, opts.format || "raw").body + "\n");
}

export function migrate(opts) {
  const cwd = process.cwd();
  const src = path.resolve(legacyRoot(cwd));
  const dest = path.resolve(opts.dir);

  if (!fs.existsSync(src)) {
    process.stderr.write(`ccglass migrate: no ./.ccglass in ${cwd}\n`);
    process.exit(1);
  }

  if (!hasCapturedLogs(src)) {
    process.stderr.write(`ccglass migrate: no .json logs in ./.ccglass (only empty session folders?)\n`);
    process.exit(1);
  }

  fs.mkdirSync(dest, { recursive: true });
  let files = 0;

  for (const session of listSessions(src)) {
    const srcDir = path.join(src, session);
    const destDir = path.join(dest, session);
    fs.mkdirSync(destDir, { recursive: true });
    for (const f of fs.readdirSync(srcDir)) {
      if (!f.endsWith(".json")) continue;
      const destFile = path.join(destDir, f);
      if (fs.existsSync(destFile)) continue;
      fs.copyFileSync(path.join(srcDir, f), destFile);
      files++;
    }
  }

  if (!files) {
    process.stderr.write(
      `ccglass migrate: no new files to copy (dest already has every ./.ccglass log from this project)\n` +
      `  dest: ${dest}\n`
    );
    process.exit(0);
  }

  process.stderr.write(
    `ccglass migrate: copied ${files} file(s) from ./.ccglass (${cwd}) → ${dest}\n` +
    `  (only logs under the current project's ./.ccglass; other directories are untouched.)\n`
  );
}

// `ccglass repack [session]` — force-migrate legacy records to v2 by reading them
// (reads auto-migrate in place). With no session, repacks every session.
export function repack(opts) {
  for (const root of opts.readRoots) {
    const sessions = listSessions(root);
    for (const s of sessions) {
      if (opts.session && s !== opts.session) continue;
      loadSession(root, s); // side effect: rewrites legacy files as v2
    }
  }
  process.stdout.write("ccglass: repack complete\n");
}

// `ccglass usage` — token + USD rollup across every captured session. Pretty-prints
// totals, top models by spend, and per-session breakdown. With `--format json`, emits
// the raw aggregator output for piping into jq.
export function usageCmd(opts) {
  // Resolve session names only for the `--by-session` table (not --by-timestamp,
  // which deliberately shows raw ids, and not the totals-only default view).
  const s = summarizeUsage(opts.readRoots, { names: opts.bySession && !opts.byTimestamp });

  if (opts.format === "json") {
    process.stdout.write(JSON.stringify(s, null, 2) + "\n");
    return;
  }

  if (!s.sessionCount) {
    process.stderr.write("ccglass usage: no captured sessions found.\n");
    process.exit(1);
  }

  const fmt = (n) => Number(n || 0).toLocaleString();
  const usd = (n) => `$${Number(n || 0).toFixed(4)}`;
  const pct = (r) => `${Math.round((r || 0) * 100)}%`;
  const range = [s.range.from, s.range.to].filter(Boolean).join(" → ") || "—";

  const out = [];
  out.push(`ccglass usage — ${s.sessionCount} sessions, ${fmt(s.requestCount)} requests measured` +
    (s.unmeasured ? ` (${s.unmeasured} unmeasured)` : ""));
  out.push(`  range: ${range}`);
  out.push("");
  out.push("totals:");
  out.push(`  input         ${fmt(s.totals.input)}`);
  out.push(`  output        ${fmt(s.totals.output)}`);
  out.push(`  cache read    ${fmt(s.totals.cacheRead)}  (${pct(s.totals.cacheHitRate)} hit)`);
  out.push(`  cache write   ${fmt(s.totals.cacheWrite)}`);
  out.push(`  cost          ${usd(s.totals.usd)}`);

  if (s.byModel.length) {
    out.push("");
    out.push("by model (sorted by spend):");
    const w = Math.max(8, ...s.byModel.map((m) => m.model.length));
    out.push(`  ${"model".padEnd(w)}  ${"req".padStart(6)}  ${"input".padStart(10)}  ${"output".padStart(10)}  ${"cacheR".padStart(10)}  ${"cacheW".padStart(10)}  ${"cost".padStart(10)}`);
    for (const m of s.byModel) {
      out.push(`  ${m.model.padEnd(w)}  ${fmt(m.requests).padStart(6)}  ${fmt(m.input).padStart(10)}  ${fmt(m.output).padStart(10)}  ${fmt(m.cacheRead).padStart(10)}  ${fmt(m.cacheWrite).padStart(10)}  ${usd(m.usd).padStart(10)}`);
    }
  }

  if (opts.bySession && s.bySession.length) {
    out.push("");
    out.push("by session (newest first):");
    // `--by-timestamp` shows only the raw timestamp id. Otherwise prepend a
    // `name` column (the agent's session title) while keeping the timestamp id
    // column, so sessions that share a title — e.g. ccglass restarted in the
    // same Claude conversation — stay distinguishable and remain usable with
    // `ccglass rm`/`export`. Cap names so a long first-prompt fallback can't
    // blow out the column (the full name stays in --format json).
    const showName = !opts.byTimestamp;
    const cap = (str) => (str.length > 48 ? str.slice(0, 47) + "…" : str);
    const nameOf = (x) => (x.name ? cap(x.name) : "—");
    const wId = Math.max(7, ...s.bySession.map((x) => x.session.length));
    const wName = showName ? Math.max(4, ...s.bySession.map((x) => nameOf(x).length)) : 0;
    // Left columns vary by mode; the numeric tail is identical for header + rows.
    const lead = (name, id) => (showName ? `${name.padEnd(wName)}  ${id.padEnd(wId)}` : id.padEnd(wId));
    const tail = (req, input, output, cacheR, cacheW, cost) =>
      `  ${req.padStart(6)}  ${input.padStart(10)}  ${output.padStart(10)}  ${cacheR.padStart(10)}  ${cacheW.padStart(10)}  ${cost.padStart(10)}`;
    out.push(`  ${lead("name", "session")}${tail("req", "input", "output", "cacheR", "cacheW", "cost")}`);
    for (const x of s.bySession) {
      out.push(`  ${lead(nameOf(x), x.session)}${tail(fmt(x.requests), fmt(x.input), fmt(x.output), fmt(x.cacheRead), fmt(x.cacheWrite), usd(x.usd))}`);
    }
  }

  process.stdout.write(out.join("\n") + "\n");
}

// `ccglass rm <session>` — delete a session across read roots and GC orphan blobs.
export function rmCmd(session, opts) {
  if (!session) {
    process.stderr.write("ccglass rm: usage: ccglass rm <session>\n");
    process.exit(1);
  }
  if (session !== path.basename(session) || session === "." || session === "..") {
    process.stderr.write(`ccglass rm: invalid session: ${session}\n`);
    process.exit(1);
  }
  let removed = 0;
  for (const root of opts.readRoots) {
    if (fs.existsSync(path.join(root, session))) { rmSession(root, session); removed++; }
  }
  if (!removed) {
    process.stderr.write(`ccglass rm: session not found: ${session}\n`);
    process.exit(1);
  }
  process.stdout.write(`ccglass: removed ${session}\n`);
}
