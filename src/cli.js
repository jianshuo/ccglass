// CLI orchestration: resolve which client to inspect, start proxy + dashboard,
// spawn the client with its base-URL env var pointed at the proxy, clean up.

import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Store, readEntryById } from "./store.js";
import { createProxy } from "./proxy.js";
import { createServer } from "./server.js";
import { resolveProvider, PROVIDERS, PICKABLE } from "./providers.js";
import { renderExport } from "./export.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;

const HELP = `ccglass v${VERSION} — see what your coding agent sends to the model

USAGE
  ccglass                       Pick a client interactively (claude / codex / deepseek / kimi)
  ccglass claude [args...]      Inspect Claude Code
  ccglass codex  [args...]      Inspect Codex (OpenAI)
  ccglass deepseek [args...]    Inspect DeepSeek-TUI
  ccglass kimi   [args...]      Inspect Kimi (Moonshot, via Claude Code)
  ccglass opencode [args...]  Inspect OpenCode
  ccglass run [--provider P] -- <cmd...>   Inspect any client
  ccglass view                  Open the dashboard over existing .ccglass/ logs
  ccglass export <id> [--format raw|md|json|har]

OPTIONS
  --provider <claude|codex|deepseek|kimi|openai>   Force format/env for \`run\`
  --upstream <url>    Override the upstream API
  --port <n>          Dashboard port (default: auto)
  --proxy-port <n>    Proxy port (default: auto)
  --dir <path>        Log directory (default: ./.ccglass)
  --no-open           Do NOT open the dashboard in your browser (opens by default)
  --no-redact         Do NOT mask auth tokens in saved logs
  --no-mcp            Do NOT inject ccglass's inspection tools into Claude Code
  --no-settings-override   Do NOT force Claude Code onto the proxy via --settings
                           (use if a provider switcher set ANTHROPIC_BASE_URL)
  --env-var <name>    Override the environment variable used to set the proxy URL
                           (default depends on provider, e.g. ANTHROPIC_BASE_URL)
  -h, --help          Show this help
  -v, --version       Show version

EXAMPLES
  ccglass claude              # then chat in claude; watch http://127.0.0.1:<port>
  ccglass codex
  ccglass deepseek
  ccglass run --provider openai -- my-openai-cli
  ccglass run --provider claude --env-var MY_CUSTOM_BASE_URL -- my-tool
  ccglass export <id> --format raw > request.http`;

function parseArgs(argv) {
  const opts = { dir: path.resolve(".ccglass"), redact: true, mcp: true, open: true, settingsOverride: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--proxy-port") opts.proxyPort = Number(argv[++i]);
    else if (a === "--dir") opts.dir = path.resolve(argv[++i]);
    else if (a === "--upstream") opts.upstream = argv[++i];
    else if (a === "--provider") opts.provider = argv[++i];
    else if (a === "--open") opts.open = true;
    else if (a === "--no-open") opts.open = false;
    else if (a === "--no-redact") opts.redact = false;
    else if (a === "--no-mcp") opts.mcp = false;
    else if (a === "--no-settings-override") opts.settingsOverride = false;
    else if (a === "--env-var") opts.envVar = argv[++i];
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

// Claude Code accepts `--mcp-config <json>` to register MCP servers for a single
// session without touching the user's persistent config. When inspecting a
// Claude-based client, point it at our own stdio MCP (src/mcp.js) so the agent
// can query the very requests it just made. CCGLASS_ROOT must match this run's
// log dir, or the MCP would read a stale ./.ccglass instead.
function mcpArgs(opts) {
  const config = {
    mcpServers: {
      ccglass: {
        command: process.execPath,
        args: [path.join(__dirname, "mcp.js")],
        env: { CCGLASS_ROOT: opts.dir },
      },
    },
  };
  return ["--mcp-config", JSON.stringify(config)];
}

// Read ANTHROPIC_BASE_URL from Claude Code's settings.json env block. A provider
// switcher (cc-switch etc.) writes the active provider's base URL here, which
// otherwise makes claude bypass our proxy. Project settings shadow user settings
// in Claude Code's precedence, so check them in the same order.
function settingsEnvBaseUrl() {
  const files = [
    path.resolve(".claude/settings.local.json"),
    path.resolve(".claude/settings.json"),
    path.join(os.homedir(), ".claude", "settings.json"),
  ];
  for (const f of files) {
    try {
      const url = JSON.parse(fs.readFileSync(f, "utf8"))?.env?.ANTHROPIC_BASE_URL;
      if (url) return url;
    } catch {}
  }
  return null;
}

async function wrap(command, args, opts) {
  const provider = resolveProvider(command, opts.provider, opts.envVar);
  const claudeBased = provider.command === "claude";

  // If a provider switcher wrote ANTHROPIC_BASE_URL into settings.json and the
  // user didn't override --upstream, forward there by default (the plain claude
  // provider's default upstream is anthropic.com; kimi etc. keep their own).
  const settingsBaseUrl = claudeBased ? settingsEnvBaseUrl() : null;
  let upstream = opts.upstream || (provider.upstream === "auto" ? null : provider.upstream);
  // autoUpstream: resolve upstream from the same env var we're about to override
  if (!upstream && provider.autoUpstream) upstream = process.env[provider.envVar];
  if (!opts.upstream && settingsBaseUrl && provider.upstream === "https://api.anthropic.com") {
    upstream = settingsBaseUrl;
    process.stderr.write(`  \x1b[36m●\x1b[0m ccglass: upstream from Claude Code settings.json → ${upstream}\n`);
  }

  if (provider.mcp && opts.mcp) args = [...mcpArgs(opts), ...args];

  const store = new Store({ root: opts.dir, redact: opts.redact, format: provider.format });
  const proxy = createProxy({ upstream, store });
  const dashboard = createServer({ root: opts.dir, store });

  const proxyPort = await listen(proxy, opts.proxyPort);
  const dashPort = await listen(dashboard, opts.port);
  const dashUrl = `http://127.0.0.1:${dashPort}`;
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;

  process.stderr.write(banner(dashUrl, provider, upstream));
  if (opts.open) openBrowser(dashUrl);

  // Command-line --settings outranks ~/.claude/settings.json and deep-merges
  // (the user's hooks/plugins/theme are preserved), so this reliably points
  // claude at our proxy even when a switcher set a base URL there — and sidesteps
  // the env-var precedence regression in some Claude Code versions.
  if (claudeBased && opts.settingsOverride && !provider.noSettings) {
    if (settingsBaseUrl)
      process.stderr.write(`  \x1b[33mnote:\x1b[0m settings.json sets ANTHROPIC_BASE_URL=${settingsBaseUrl}; overriding it so claude hits the proxy\n`);
    args = ["--settings", JSON.stringify({ env: { ANTHROPIC_BASE_URL: proxyUrl } }), ...args];
  }

  const spawnCmd = provider.command || command;
  const child = spawn(spawnCmd, args, {
    stdio: "inherit",
    env: { ...process.env, [provider.envVar]: proxyUrl },
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
  process.stdout.write(renderExport(rec, opts.format || "raw").body + "\n");
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
