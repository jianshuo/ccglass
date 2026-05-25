// CLI orchestration: resolve which client to inspect, start proxy + dashboard,
// spawn the client with its base-URL env var pointed at the proxy, clean up.

import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { proxyArgs } from "./child-args.js";
import { spawnCommand } from "./spawn-command.js";
import { Store, hasCapturedLogs } from "./store.js";
import { exportEntry, migrate } from "./log-cli.js";
import { createProxy } from "./proxy.js";
import { createServer } from "./server.js";
import { resolveProvider, PROVIDERS, PICKABLE } from "./providers.js";
import { globalRoot, legacyRoot, readRoots } from "./paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;

const HELP = `ccglass v${VERSION} — see what your coding agent sends to the model

USAGE
  ccglass                       Pick a client interactively (claude / codex / deepseek / kimi)
  ccglass claude [args...]      Inspect Claude Code
  ccglass codex  [args...]      Inspect Codex (OpenAI)
  ccglass deepseek [args...]    Inspect DeepSeek-TUI
  ccglass kimi   [args...]      Inspect Kimi (Moonshot, via Claude Code)
  ccglass opencode [args...]    Inspect OpenCode
  ccglass run [--provider P] -- <cmd...>   Inspect any client
  ccglass view                  Open the dashboard over saved logs
  ccglass migrate               Copy ./.ccglass logs (this project only) to the global store
  ccglass export <id> [--format raw|md|json|har]

OPTIONS
  --provider <p>      Force format/env for \`run\`
                      Built-in: claude|codex|codex-azure|deepseek|kimi|openai|opencode
                              glm|ollama|lmstudio|openrouter|bedrock|vertex
  --upstream <url>    Override the upstream API (alias: --base-url)
  --base-url <url>    Alias for --upstream
  --port <n>          Dashboard port (default: auto)
  --proxy-port <n>    Proxy port (default: auto)
  --dir <path>        Log directory (default: ~/.ccglass/sessions/<full-path>-<hash>)
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
  ccglass codex-azure         # set AZURE_OPENAI_ENDPOINT first
  ccglass deepseek
  ccglass run --provider ollama -- my-openai-cli
  ccglass run --provider openrouter -- my-openai-cli
  ccglass run --provider glm -- my-openai-cli     # set OPENAI_BASE_URL first
  ccglass run --provider bedrock -- claude        # set ANTHROPIC_BEDROCK_BASE_URL first
  ccglass run --upstream https://my.api/v1 --env-var MY_BASE_URL -- my-tool
  ccglass export <id> --format raw > request.http`;

function parseArgs(argv) {
  const opts = { dir: null, redact: true, mcp: true, open: true, settingsOverride: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--proxy-port") opts.proxyPort = Number(argv[++i]);
    else if (a === "--dir") opts.dir = path.resolve(argv[++i]);
    else if (a === "--upstream" || a === "--base-url") opts.upstream = argv[++i];
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
  const p = spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
  p.on("error", () => {});
  p.unref();
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
// log dir, or the MCP would read a stale store instead.
function maybeLegacyHint(cwd, captureDir) {
  const legacy = legacyRoot(cwd);
  if (!hasCapturedLogs(legacy)) return;
  if (hasCapturedLogs(captureDir)) return;
  process.stderr.write(
    `  \x1b[33mnote:\x1b[0m found logs in ./.ccglass (this project directory only).\n` +
    `        This run saves new captures under ${captureDir}\n` +
    `        Run \`ccglass migrate\` to copy ./.ccglass from the current directory into that store.\n`
  );
}

function mcpArgs(opts) {
  const config = {
    mcpServers: {
      ccglass: {
        command: process.execPath,
        args: [path.join(__dirname, "mcp.js")],
        env: {
          CCGLASS_ROOT: opts.dir,
          CCGLASS_CWD: process.cwd(),
        },
      },
    },
  };
  return ["--mcp-config", JSON.stringify(config)];
}

// Run `codex doctor` and parse the auth mode / endpoint so we can warn the user
// when Codex is configured with ChatGPT auth (wss:// websocket transport), which
// bypasses OPENAI_BASE_URL and therefore never reaches our proxy.
function detectCodexChatGPTAuth() {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };

    let child;
    try {
      child = spawnCommand("codex", ["doctor"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return finish(null);
    }

    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(null); }, 5000);
    const collect = (d) => { output += d; };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", () => { clearTimeout(timer); finish(null); });
    child.on("close", () => {
      clearTimeout(timer);
      const authMatch = output.match(/auth\s+mode\s+(\S+)/i);
      const endpointMatch = output.match(/endpoint\s+(\S+)/i);
      finish({
        authMode: authMatch?.[1]?.toLowerCase() ?? null,
        endpoint: endpointMatch?.[1] ?? null,
      });
    });
  });
}

// Read model_providers.*.base_url from ~/.codex/config.toml. Codex prioritizes
// config.toml over OPENAI_BASE_URL, so we must read the configured upstream from
// there and override it via -c flag when spawning codex.
function codexConfigBaseUrl() {
  const configPath = path.join(os.homedir(), ".codex", "config.toml");
  if (!fs.existsSync(configPath)) return null;
  const toml = fs.readFileSync(configPath, "utf8");
  const m = toml.match(/^\[model_providers\.(\S+)\][^\[]*?^base_url\s*=\s*"([^"]+)"/m);
  return m ? { provider: m[1], baseUrl: m[2] } : null;
}
// Read the provider's base-URL env var from Claude Code's settings.json env
// block. A provider switcher (cc-switch etc.) writes the active provider's base
// URL here, which otherwise makes claude bypass our proxy. Project settings
// shadow user settings in Claude Code's precedence, so check them in the same
// order. The env var differs by mode: ANTHROPIC_BASE_URL for vanilla Claude,
// ANTHROPIC_BEDROCK_BASE_URL when CLAUDE_CODE_USE_BEDROCK=1, etc.
function settingsEnvBaseUrl(envVar) {
  const files = [
    path.resolve(".claude/settings.local.json"),
    path.resolve(".claude/settings.json"),
    path.join(os.homedir(), ".claude", "settings.json"),
  ];
  for (const f of files) {
    try {
      const url = JSON.parse(fs.readFileSync(f, "utf8"))?.env?.[envVar];
      if (url) return url;
    } catch {}
  }
  return null;
}

async function wrap(command, args, opts) {
  const provider = resolveProvider(command, opts.provider, opts.envVar);
  const claudeBased = provider.command === "claude";

  // Detect Codex ChatGPT-auth / websocket mode early so we can warn the user
  // before opening the (otherwise empty) dashboard.
  let codexChatGPTInfo = null;
  if (provider.command === "codex") {
    const info = await detectCodexChatGPTAuth();
    if (info?.authMode === "chatgpt" || info?.endpoint?.startsWith("wss://")) {
      codexChatGPTInfo = info;
    }
  }

  // If a provider switcher wrote ANTHROPIC_BASE_URL into settings.json and the
  // user didn't override --upstream, forward there by default (the plain claude
  // provider's default upstream is anthropic.com; kimi etc. keep their own).
  const settingsBaseUrl = claudeBased ? settingsEnvBaseUrl(provider.envVar) : null;
  const codexBased = provider.command === "codex" && !provider.autoUpstream;
  const codexConfig = codexBased ? codexConfigBaseUrl() : null;
  let upstream = opts.upstream
    || (codexConfig && codexConfig.baseUrl)
    || (provider.upstream === "auto" ? null : provider.upstream);
  // autoUpstream: resolve upstream from the same env var we're about to override
  if (!upstream && provider.autoUpstream) upstream = process.env[provider.envVar];
  // Picking the upstream from settings.json covers two cases: vanilla Claude
  // (default upstream is anthropic.com, switchers write ANTHROPIC_BASE_URL) and
  // autoUpstream providers like bedrock/vertex (no fixed upstream — settings.json
  // is often where the user's gateway URL lives).
  if (!opts.upstream && settingsBaseUrl && (provider.upstream === "https://api.anthropic.com" || provider.autoUpstream)) {
    upstream = settingsBaseUrl;
    process.stderr.write(`  \x1b[36m●\x1b[0m ccglass: upstream from Claude Code settings.json → ${upstream}\n`);
  }
  if (!opts.upstream && codexConfig) {
    process.stderr.write(`  \x1b[36m●\x1b[0m ccglass: upstream from Codex config.toml → ${codexConfig.baseUrl}\n`);
  }
  // A provider switcher (e.g. cc-switch) may have set ANTHROPIC_BASE_URL directly in the
  // environment rather than in settings.json — pick it up so the proxy forwards to the
  // right third-party API instead of defaulting to api.anthropic.com.
  if (!opts.upstream && !settingsBaseUrl && claudeBased && process.env[provider.envVar] &&
      provider.upstream === "https://api.anthropic.com") {
    upstream = process.env[provider.envVar];
    process.stderr.write(`  \x1b[36m●\x1b[0m ccglass: upstream from ${provider.envVar} env → ${upstream}\n`);
  }

  if (!upstream) {
    process.stderr.write(
      `ccglass: ${provider.label} needs an upstream URL.\n` +
      `  Set ${provider.envVar} in your environment, or pass --upstream <url>.\n`
    );
    process.exit(1);
  }

  try {
    const parsedUpstream = new URL(upstream);
    if (parsedUpstream.protocol !== "http:" && parsedUpstream.protocol !== "https:") {
      throw new Error("bad protocol");
    }
  } catch {
    process.stderr.write(
      `ccglass: invalid upstream URL: "${upstream}"\n` +
      `  The URL must start with http:// or https://, e.g. https://api.openai.com\n` +
      `  Check the value of ${provider.envVar} in your environment, or pass --upstream <url>.\n`
    );
    process.exit(1);
  }

  if (provider.mcp && opts.mcp) args = [...mcpArgs(opts), ...args];

  maybeLegacyHint(process.cwd(), opts.dir);

  const store = new Store({ root: opts.dir, redact: opts.redact, format: provider.format });
  const proxy = createProxy({ upstream, store });
  const dashboard = createServer({ roots: opts.readRoots, store });

  const proxyPort = await listen(proxy, opts.proxyPort);
  const dashPort = await listen(dashboard, opts.port);
  const dashUrl = `http://127.0.0.1:${dashPort}`;
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  args = proxyArgs(args, provider.envVar, proxyUrl, process.env, upstream);

  process.stderr.write(banner(dashUrl, provider, upstream));
  if (codexChatGPTInfo) {
    const ep = codexChatGPTInfo.endpoint ? ` (${codexChatGPTInfo.endpoint})` : "";
    process.stderr.write(
      `  \x1b[33m⚠\x1b[0m  Codex is using ChatGPT auth${ep}.\n` +
      `     This websocket transport bypasses OPENAI_BASE_URL — the dashboard will be empty.\n` +
      `     To capture traffic, switch Codex to API-key mode (OPENAI_API_KEY).\n\n`
    );
  }
  // Direct AWS Bedrock signs requests with SigV4, which covers the Host header.
  // A reverse proxy rewrites Host before forwarding, so AWS rejects with a
  // signature mismatch. The fix only works with Bedrock-compat gateways that
  // don't sign on Host (bearer tokens, mTLS, etc.).
  if (provider.envVar === "ANTHROPIC_BEDROCK_BASE_URL") {
    try {
      const host = new URL(upstream).hostname;
      if (host.endsWith(".amazonaws.com")) {
        process.stderr.write(
          `  \x1b[33m⚠\x1b[0m  Direct AWS Bedrock (${host}) uses SigV4 signing that includes the Host header.\n` +
          `     ccglass rewrites Host when forwarding, so AWS will reject the proxied request.\n` +
          `     Point ANTHROPIC_BEDROCK_BASE_URL at a Bedrock-compat gateway in front of AWS instead.\n\n`
        );
      }
    } catch {}
  }
  if (opts.open) openBrowser(dashUrl);

  // Command-line --settings outranks ~/.claude/settings.json and deep-merges
  // (the user's hooks/plugins/theme are preserved), so this reliably points
  // claude at our proxy even when a switcher set a base URL there — and sidesteps
  // the env-var precedence regression in some Claude Code versions.
  if (claudeBased && opts.settingsOverride && !provider.noSettings) {
    if (settingsBaseUrl)
      process.stderr.write(`  \x1b[33mnote:\x1b[0m settings.json sets ${provider.envVar}=${settingsBaseUrl}; overriding it so claude hits the proxy\n`);
    args = ["--settings", JSON.stringify({ env: { [provider.envVar]: proxyUrl } }), ...args];
  }

  // Codex config.toml base_url outranks OPENAI_BASE_URL. Override it via -c
  // so codex talks to our proxy instead of going direct.
  if (codexBased && codexConfig) {
    const configKey = `model_providers.${codexConfig.provider}.base_url`;
    // Use proxyUrl (origin only, no path). Codex appends the endpoint path
    // (e.g. /responses) to base_url. The upstream URL retains the /v1 prefix,
    // so proxy receives /responses and correctly forwards to /v1/responses.
    args = ["-c", `${configKey}="${proxyUrl}"`, ...args];
    if (codexConfig.baseUrl)
      process.stderr.write(`  \x1b[33mnote:\x1b[0m config.toml sets ${configKey}=${codexConfig.baseUrl}; overriding via -c\n`);
  }

  const spawnCmd = provider.command || command;
  const child = spawnCommand(spawnCmd, args, {
    stdio: "inherit",
    env: { ...process.env, [provider.envVar]: proxyUrl },
  });

  const shutdown = (code) => {
    proxy.close();
    dashboard.close();
    process.exit(code ?? 0);
  };

  child.on("error", (e) => {
    if (e.code === "ENOENT") {
      process.stderr.write(`\nccglass: command not found: ${spawnCmd}\n`);
      process.stderr.write(`  Make sure '${spawnCmd}' is installed and available in your PATH.\n`);
      if (process.platform === "win32")
        process.stderr.write(`  On Windows, try reinstalling it (e.g. npm install -g ${spawnCmd}) and reopen your terminal.\n`);
    } else {
      process.stderr.write(`\nccglass: ${e.message}\n`);
    }
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
  const hasAny = opts.readRoots.some((r) => fs.existsSync(r));
  if (!hasAny) {
    process.stderr.write(`ccglass: no logs found. Run \`ccglass\` first.\n`);
    process.exit(1);
  }
  const dashboard = createServer({ roots: opts.readRoots, store: null });
  const dashPort = await listen(dashboard, opts.port);
  const dashUrl = `http://127.0.0.1:${dashPort}`;
  process.stderr.write(`\n  \x1b[36m●\x1b[0m ccglass dashboard: \x1b[1m${dashUrl}\x1b[0m  (viewing saved logs — Ctrl-C to stop)\n`);
  if (opts.open) openBrowser(dashUrl);
}

export { exportEntry, migrate } from "./log-cli.js";

export async function main(argv) {
  const { opts, rest } = parseArgs(argv);
  const cwd = process.cwd();

  if (!opts.dir) opts.dir = globalRoot(cwd);
  opts.readRoots = readRoots(opts.dir, cwd);

  const cmd = rest[0];

  if (rest.includes("-h") || rest.includes("--help")) return void process.stdout.write(HELP + "\n");
  if (rest.includes("-v") || rest.includes("--version")) return void process.stdout.write(VERSION + "\n");

  if (cmd === "view") return view(opts);
  if (cmd === "migrate") return migrate(opts);
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