import fs from "node:fs";
import path from "node:path";
import { legacyRoot } from "./paths.js";
import { listSessions, hasCapturedLogs, readEntryByIdMulti } from "./store.js";
import { renderExport } from "./export.js";

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
