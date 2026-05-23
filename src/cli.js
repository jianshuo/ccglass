// CLI orchestration: resolve which client to inspect, start proxy + dashboard,
// spawn the client with its base-URL env var pointed at the proxy, clean up.

import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Store, readEntryById } from "./store.js";
import { createProxy } from "./proxy.js";
import { createServer } from "./server.js";
import { resolveProvider, PROVIDERS, PICKABLE } from "./providers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;

const HELP = `ccglass v${VERSION} — see what your coding agent sends to the model

USAGE
  ccglass                       Pick a client interactively (claude / codex / deepseek / kimi)
  ccglass claude [args...]      Inspect Claude Code
  ccglass codex  [args...]      Inspect Codex (OpenAI)
  ccglass deepseek [args...]    Inspect DeepSeek-TUI
  ccglass kimi   [args...]      Inspect Kimi (Moonshot, via Claude Code)
  ccglass run [--provider P] -- <cmd...>   Inspect any client
  ccglass view                  Open the dashboard over existing .ccglass/ logs
  ccglass export <id> [--format md|json|har]

OPTIONS
  --provider <claude|codex|deepseek|kimi|openai>   Force format/env for \`run\`
  --upstream <url>    Override the upstream API
  --port <n>          Dashboard port (default: auto)
  --proxy-port <n>    Proxy port (default: auto)
  --dir <path>        Log directory (default: ./.ccglass)
  --open              Open the dashboard in your browser
  --no-redact         Do NOT mask auth tokens in saved logs
  -h, --help          Show this help
  -v, --version       Show version

EXAMPLES
  ccglass claude              # then chat in claude; watch http://127.0.0.1:<port>
  ccglass codex
  ccglass deepseek
  ccglass run --provider openai -- my-openai-cli`;

function parseArgs(argv) {
  const opts = { dir: path.resolve(".ccglass"), redact: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--proxy-port") opts.proxyPort = Number(argv[++i]);
    else if (a === "--dir") opts.dir = path.resolve(argv[++i]);
    else if (a === "--upstream") opts.upstream = argv[++i];
    else if (a === "--provider") opts.provider = argv[++i];
    else if (a === "--open") opts.open = true;
    else if (a === "--no-redact") opts.redact = false;
    else if (a === "--format") opts.format = argv[++i];
    else rest.push(a);
  }
  return { opts, rest };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port ?? 0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
}

const banner = (dashUrl, provider, upstream) =>
  `\n  \x1b[36m●\x1b[0m ccglass watching \x1b[1m${provider.label}\x1b[0m → ${upstream}` +
  `\n    dashboard: \x1b[1m${dashUrl}\x1b[0m\n` +
  (provider.note ? `    \x1b[33mnote:\x1b[0m ${provider.note}\n` : "");

// Pick a client when ccglass is run with no command.
function pickProvider() {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve(null);
    process.stdout.write("\n  Which client do you want to inspect?\n\n");
    PICKABLE.forEach((k, i) => process.stdout.write(`    ${i + 1}) ${PROVIDERS[k].label}\n`));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("\n  > ", (ans) => {
      rl.close();
      const idx = parseInt(String(ans).trim(), 10) - 1;
      const key = PICKABLE[idx] || (PROVIDERS[String(ans).trim()] ? String(ans).trim() : null);
      resolve(key);
    });
  });
}

async function wrap(command, args, opts) {
  const provider = resolveProvider(command, opts.provider);
  const upstream = opts.upstream || provider.upstream;

  const store = new Store({ root: opts.dir, redact: opts.redact, format: provider.format });
  const proxy = createProxy({ upstream, store });
  const dashboard = createServer({ root: opts.dir, store });

  const proxyPort = await listen(proxy, opts.proxyPort);
  const dashPort = await listen(dashboard, opts.port);
  const dashUrl = `http://127.0.0.1:${dashPort}`;

  process.stderr.write(banner(dashUrl, provider, upstream));
  if (opts.open) openBrowser(dashUrl);

  const spawnCmd = provider.command || command;
  const child = spawn(spawnCmd, args, {
    stdio: "inherit",
    env: { ...process.env, [provider.envVar]: `http://127.0.0.1:${proxyPort}` },
  });

  const shutdown = (code) => {
    proxy.close();
    dashboard.close();
    process.exit(code ?? 0);
  };

  child.on("error", (e) => {
    if (e.code === "ENOENT") process.stderr.write(`\nccglass: command not found: ${spawnCmd}\n`);
    else process.stderr.write(`\nccglass: ${e.message}\n`);
    shutdown(1);
  });
  child.on("exit", (code) => {
    process.stderr.write(`\n  \x1b[36m●\x1b[0m ccglass: ${spawnCmd} exited. Logs saved to ${path.relative(process.cwd(), store.sessionDir)}\n`);
    process.stderr.write(`    Re-open anytime with: ccglass view\n`);
    shutdown(code ?? 0);
  });

  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
}

async function view(opts) {
  if (!fs.existsSync(opts.dir)) {
    process.stderr.write(`ccglass: no logs found at ${opts.dir}. Run \`ccglass\` first.\n`);
    process.exit(1);
  }
  const dashboard = createServer({ root: opts.dir, store: null });
  const dashPort = await listen(dashboard, opts.port);
  const dashUrl = `http://127.0.0.1:${dashPort}`;
  process.stderr.write(`\n  \x1b[36m●\x1b[0m ccglass dashboard: \x1b[1m${dashUrl}\x1b[0m  (viewing saved logs — Ctrl-C to stop)\n`);
  if (opts.open) openBrowser(dashUrl);
}

function exportEntry(id, opts) {
  const rec = readEntryById(opts.dir, id);
  if (!rec) {
    process.stderr.write(`ccglass: no entry ${id} under ${opts.dir}\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(rec, null, 2) + "\n");
}

export async function main(argv) {
  const { opts, rest } = parseArgs(argv);
  const cmd = rest[0];

  if (rest.includes("-h") || rest.includes("--help")) return void process.stdout.write(HELP + "\n");
  if (rest.includes("-v") || rest.includes("--version")) return void process.stdout.write(VERSION + "\n");

  if (cmd === "view") return view(opts);
  if (cmd === "export") return exportEntry(rest[1], opts);
  if (cmd === "run") {
    const dashIdx = rest.indexOf("--");
    const cmdArgs = dashIdx >= 0 ? rest.slice(dashIdx + 1) : rest.slice(1);
    if (!cmdArgs.length) return void process.stderr.write("ccglass run: nothing to run. Use `ccglass run -- <cmd>`\n");
    return wrap(cmdArgs[0], cmdArgs.slice(1), opts);
  }

  // No command: interactive picker (falls back to help when non-interactive).
  if (!cmd) {
    const key = await pickProvider();
    if (!key) return void process.stdout.write(HELP + "\n");
    return wrap(key, [], opts);
  }

  // Default: treat the first token as a provider/command to wrap.
  return wrap(cmd, rest.slice(1), opts);
}
