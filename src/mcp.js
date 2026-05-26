// ccglass MCP server: exposes the captured request/response logs to any MCP
// client (e.g. Claude Code) as read-only query tools. This lets the agent
// inspect what it actually sent to the model — sessions, request summaries,
// full prompts, and token/cost rollups — without leaving the chat.
//
// Run: node src/mcp.js   (root resolved from $CCGLASS_ROOT or global path)

import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { listSessionsMulti, loadSessionMulti, summarize, readEntryByIdMulti } from "./store.js";
import { getAdapter, detectFormat } from "./formats/index.js";
import { globalRoot, readRoots } from "./paths.js";
import { summarizeUsage } from "./usage.js";

// Parse one captured record's streamed response into { usage, cost } using the
// same per-format adapter the dashboard uses (Anthropic / OpenAI / DeepSeek…).
function priceOf(rec) {
  const adapter = getAdapter(detectFormat(rec));
  const resp = rec.response?.raw ? adapter.reassemble(rec.response.raw) : rec.response || {};
  const usage = resp?.usage || {};
  return { usage, cost: adapter.cost(rec.request?.body?.model, usage), reassembled: resp };
}

const CWD = process.env.CCGLASS_CWD
  ? path.resolve(process.env.CCGLASS_CWD)
  : process.cwd();

const ROOT = process.env.CCGLASS_ROOT
  ? path.resolve(process.env.CCGLASS_ROOT)
  : globalRoot(CWD);

const ROOTS = readRoots(ROOT, CWD);

const usd = (n) => `$${n.toFixed(4)}`;
const json = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });

const server = new McpServer({ name: "ccglass", version: "0.1.0" });

server.registerTool(
  "list_sessions",
  {
    title: "List capture sessions",
    description:
      "List all ccglass capture sessions (newest first) with entry count, time range, token breakdown, and total USD cost.",
    inputSchema: {},
  },
  async () => {
    // bySession is already newest-first (inherits listSessionsMulti order).
    const summary = summarizeUsage(ROOTS);
    const sessions = summary.bySession.map((s) => ({
      session: s.session,
      entries: s.entries,
      from: s.from,
      to: s.to,
      tokens: {
        input: s.input,
        output: s.output,
        cacheRead: s.cacheRead,
        cacheWrite: s.cacheWrite,
      },
      cost: usd(s.usd),
    }));
    return json({ root: ROOT, count: sessions.length, sessions });
  },
);

server.registerTool(
  "usage_summary",
  {
    title: "Token usage summary",
    description:
      "Aggregate token usage and USD cost across every captured session. Returns totals, per-model breakdown (sorted by spend), per-session breakdown, the date range covered, and an `unmeasured` count of records whose response had no parseable usage (in-flight, errored, non-LLM).",
    inputSchema: {},
  },
  async () => {
    return json({ root: ROOT, ...summarizeUsage(ROOTS) });
  },
);

server.registerTool(
  "recent_requests",
  {
    title: "Recent requests",
    description:
      "List request summaries for a session (defaults to the latest). Each row: seq, model, message/tool counts, HTTP status, timestamp.",
    inputSchema: {
      session: z.string().optional().describe("Session id; defaults to the latest session"),
      limit: z.number().int().positive().max(200).optional().describe("Max rows (default 20)"),
    },
  },
  async ({ session, limit = 20 }) => {
    const sess = session || listSessionsMulti(ROOTS)[0];
    if (!sess) return json({ error: "no sessions found", root: ROOT });
    const rows = loadSessionMulti(ROOTS, sess).map(summarize).slice(-limit).reverse();
    return json({ session: sess, count: rows.length, requests: rows });
  },
);

server.registerTool(
  "request_detail",
  {
    title: "Request detail",
    description:
      "Full detail for one captured request by id (e.g. '2026-05-23T11-40-32-981Z/0003'): model, system prompt, message roles, tool names, response status, and token usage + cost.",
    inputSchema: {
      id: z.string().describe("Request id in the form '<session>/<seq>', e.g. 'SESSION/0003'"),
    },
  },
  async ({ id }) => {
    const rec = readEntryByIdMulti(ROOTS, id);
    if (!rec) return json({ error: "not found", id });
    const b = rec.request?.body || {};
    const sys = Array.isArray(b.system)
      ? b.system.map((s) => s.text || "").join("\n")
      : typeof b.system === "string"
        ? b.system
        : "";
    const { usage, cost } = priceOf(rec);
    return json({
      id: rec.id,
      ts: new Date(rec.ts).toISOString(),
      model: b.model,
      url: rec.request?.url,
      status: rec.response?.status ?? null,
      systemPrompt: sys.length > 6000 ? sys.slice(0, 6000) + "\n…[truncated]" : sys,
      messages: (b.messages || []).map((m) => ({
        role: m.role,
        preview:
          typeof m.content === "string"
            ? m.content.slice(0, 200)
            : (m.content || []).map((c) => c.type).join(","),
      })),
      tools: (b.tools || []).map((t) => t.name),
      usage,
      cost,
    });
  },
);

await server.connect(new StdioServerTransport());
