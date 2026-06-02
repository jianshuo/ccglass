// Export a captured record to a downloadable artifact. Shared by the dashboard
// (`/api/export`) and the CLI (`ccglass export`).
//
//   raw  — full HTTP transcript (request line, headers, body, then the
//          response), with every JSON payload pretty-printed so a human can
//          read exactly what was sent: the complete system prompt, messages,
//          and tool definitions, indented and unescaped.
//   md   — human-readable system/messages/tools/response breakdown.
//   har  — HTTP Archive, importable into browser devtools.
//   json — the full stored record (parsed body + raw response + metadata).

import { getAdapter, detectFormat } from "./formats/index.js";
import { localTimestamp } from "./store.js";

const headerLines = (headers) =>
  Object.entries(headers || {})
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
    .join("\n");

// Compact, faithful request body for machine consumers (HAR import).
function requestBody(rec) {
  const r = rec.request || {};
  if (typeof r.bodyRaw === "string") return r.bodyRaw;
  if (r.body == null) return "";
  return typeof r.body === "string" ? r.body : JSON.stringify(r.body);
}

// Pretty-print for human reading. Objects are indented JSON; strings that
// happen to be JSON (a parsed-then-stored body, an error payload) get parsed
// and re-indented; anything else (e.g. an SSE event stream) is left verbatim,
// since it is already line-delimited and not a single JSON document.
function pretty(value) {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export function toRaw(rec) {
  const req = rec.request || {};
  const out = [];
  out.push(`${req.method || "GET"} ${req.url || "/"} HTTP/1.1`);
  const reqHeaders = headerLines(req.headers);
  if (reqHeaders) out.push(reqHeaders);
  out.push("");
  out.push(pretty(req.bodyRaw ?? req.body));

  out.push("\n" + "=".repeat(60) + " RESPONSE " + "=".repeat(60) + "\n");

  const resp = rec.response;
  if (!resp) {
    out.push("(no response captured — request still pending or never completed)");
  } else if (resp.error) {
    out.push(`(upstream error: ${resp.error})`);
  } else {
    out.push(`HTTP/1.1 ${resp.status ?? ""}`.trim());
    const respHeaders = headerLines(resp.headers);
    if (respHeaders) out.push(respHeaders);
    out.push("");
    out.push(pretty(resp.raw));
  }
  return out.join("\n");
}

export function toMarkdown(rec) {
  const fmt = detectFormat(rec);
  const A = getAdapter(fmt);
  const body = rec.request?.body || {};
  const view = A.view(body);
  const out = [];
  out.push(`# ${rec.request?.method} ${rec.request?.url}\n`);
  out.push(`- format: ${fmt}`);
  out.push(`- model: ${body.model}`);
  out.push(`- captured: ${localTimestamp(rec.ts)}\n`);
  out.push("## System\n");
  for (const b of view.system) out.push(`**${b.label}**\n\n` + "```text\n" + b.text + "\n```\n");
  out.push("## Messages\n");
  for (const m of view.messages) out.push(`**${m.label}**\n\n` + "```text\n" + m.text + "\n```\n");
  out.push(`## Tools (${view.tools.length})\n`);
  for (const t of view.tools) out.push(`- **${t.name}** — ${(t.description || "").split("\n")[0]}`);
  if (rec.response?.raw) {
    const r = A.reassemble(rec.response.raw);
    out.push("\n## Response\n");
    out.push(`- stop_reason: ${r?.stop_reason}`);
    out.push("```json\n" + JSON.stringify(r?.usage || {}, null, 2) + "\n```");
    for (const b of r?.content || []) out.push("```text\n" + (b.text ?? JSON.stringify(b)) + "\n```\n");
  }
  return out.join("\n");
}

export function toHar(rec) {
  return {
    log: {
      version: "1.2",
      creator: { name: "ccglass", version: "0.1.0" },
      entries: [
        {
          startedDateTime: localTimestamp(rec.ts),
          request: {
            method: rec.request?.method,
            url: rec.request?.url,
            headers: Object.entries(rec.request?.headers || {}).map(([name, value]) => ({ name, value: String(value) })),
            postData: { mimeType: "application/json", text: requestBody(rec) },
          },
          response: {
            status: rec.response?.status || 0,
            content: { mimeType: "text/event-stream", text: rec.response?.raw || "" },
          },
        },
      ],
    },
  };
}

// Dispatch: returns what the HTTP layer needs to serve the download.
export function renderExport(rec, format = "md") {
  switch (format) {
    case "raw":
      return { contentType: "text/plain; charset=utf-8", ext: "http", body: toRaw(rec) };
    case "json":
      return { contentType: "application/json", ext: "json", body: JSON.stringify(rec, null, 2) };
    case "har":
      return { contentType: "application/json", ext: "har.json", body: JSON.stringify(toHar(rec), null, 2) };
    case "md":
    default:
      return { contentType: "text/markdown; charset=utf-8", ext: "md", body: toMarkdown(rec) };
  }
}
