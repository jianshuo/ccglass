// ccglass dashboard SPA. Vanilla JS, no build step.

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const fmt = (n) => (n == null ? "—" : n.toLocaleString());
const fmtMs = (ms) => {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 1 : 2)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
};
const fmtTps = (n) => {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 100) return `${Math.round(n)} tok/s`;
  if (n >= 10) return `${n.toFixed(1)} tok/s`;
  return `${n.toFixed(2)} tok/s`;
};

function statusClass(status) {
  if (status == null) return "pending";
  if (status < 400) return "ok";
  if (status < 500) return "4xx";
  return "5xx";
}

function groupRetries(entries, windowMs = 60_000) {
  const out = [];
  for (const e of entries) {
    const g = out[out.length - 1];
    const lastTs = g?.retries?.at(-1)?.ts ?? g?.ts;
    if (g && g.url === e.url && g.model === e.model && g.nMessages === e.nMessages && (e.ts - lastTs) < windowMs) {
      g.retries.push(e);
    } else {
      out.push({ ...e, retries: [] });
    }
  }
  return out;
}

const LIVE = "__live__"; // sentinel value for state.selected meaning "live stream view"

const state = {
  session: null, live: null, entries: [], sessionStats: null, sessionModels: [],
  modelFilter: "all",
  selected: null, tab: "overview", diff: false, picks: [], errorsOnly: false,
  summary: false, summaryTab: "byModel", usage: null,
  // Live-stream state — populated only while #detail shows the live timeline
  liveSeen: new Map(),     // stepKey -> true (dedup across entries)
  liveToolRows: new Map(), // callId -> DOM element of the tool_use row
  livePinned: true,        // auto-scroll to bottom unless user scrolled up
};

function entryModel(e) {
  return e.model ?? null;
}

function entriesForModelFilter(entries, modelFilter = state.modelFilter) {
  if (!modelFilter || modelFilter === "all") return entries;
  return entries.filter((e) => entryModel(e) === modelFilter);
}

/** Union of models from live entries and last API snapshot (entries win for SSE). */
function collectSessionModels() {
  const set = new Set(state.sessionModels);
  for (const e of state.entries) {
    const m = entryModel(e);
    if (m) set.add(m);
  }
  return [...set].sort();
}

function visibleEntries() {
  let visible = entriesForModelFilter(state.entries);
  if (state.errorsOnly) {
    visible = visible.filter((e) => {
      const sc = statusClass(e.status);
      return sc === "4xx" || sc === "5xx" || e.error != null;
    });
  }
  return visible;
}

function clearDetailIfHidden() {
  if (!state.selected) return;
  if (state.selected === LIVE) return; // Live view always remains valid
  if (visibleEntries().some((e) => e.id === state.selected)) return;
  state.selected = null;
  state.picks = [];
  $("#detail").innerHTML = '<div class="empty">Select a request, or start chatting in Claude Code.</div>';
}

function sessionStatsQuery() {
  const q = new URLSearchParams({ session: state.session });
  if (state.modelFilter && state.modelFilter !== "all") q.set("model", state.modelFilter);
  return q.toString();
}

async function api(path) {
  const r = await fetch(path);
  return r.json();
}

// ---- sessions + list -----------------------------------------------------

async function loadSessions() {
  const { sessions, live } = await api("/api/sessions");
  state.live = live;
  const sel = $("#session");
  sel.innerHTML = "";
  for (const s of sessions) {
    sel.append(el("option", { value: s, textContent: s + (s === live ? "  (live)" : "") }));
  }
  state.session = state.session || live || sessions[0] || null;
  if (state.session) sel.value = state.session;
  $("#live").classList.toggle("off", !live);
  await loadList();
  // Default the dashboard to the Live stream view on first load — most users
  // want to watch traffic, not pick from a list of HTTP rounds.
  if (!state.selected) onPick(LIVE);
}

async function loadList() {
  if (!state.session) return;
  const session = encodeURIComponent(state.session);
  const [{ entries }, stats] = await Promise.all([
    api("/api/requests?session=" + session),
    api("/api/session-stats?" + sessionStatsQuery()),
  ]);
  state.entries = entries;
  applySessionStats(stats);
  renderModelFilter();
  renderSessionStats();
  renderLatencyTrend();
  renderList();
}

function applySessionStats(stats) {
  if (stats.error) {
    state.sessionStats = null;
    state.sessionModels = [];
    return;
  }
  state.sessionStats = stats;
  state.sessionModels = stats.models || [];
}

function renderModelFilter() {
  const sel = $("#modelFilter");
  const models = collectSessionModels();
  if (!models.length) {
    sel.hidden = true;
    state.modelFilter = "all";
    return;
  }
  const prev = state.modelFilter || "all";
  sel.innerHTML =
    `<option value="all">All models</option>` +
    models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
  sel.value = prev !== "all" && models.includes(prev) ? prev : "all";
  if (sel.value !== state.modelFilter) state.modelFilter = sel.value;
  sel.hidden = false;
}

function renderSessionStats() {
  const box = $("#sessionStats");
  const s = state.sessionStats;
  if (!s || !state.session) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;
  const pct = Math.round((s.cacheHitRate || 0) * 100);
  const scope =
    state.modelFilter !== "all"
      ? `<span class="scope">${esc(state.modelFilter)}</span>`
      : "";
  box.innerHTML =
    scope +
    `<span><b>${fmt(s.totalInput)}</b> in</span>` +
    `<span><b>${fmt(s.totalOutput)}</b> out</span>` +
    `<span><b>${pct}%</b> cache</span>` +
    `<span><b>$${(s.totalUsd || 0).toFixed(4)}</b></span>`;
}

function renderLatencyTrend() {
  const box = $("#latencyTrend");
  const scoped = entriesForModelFilter(state.entries);
  const done = scoped.filter((e) => e.latencyMs != null);
  if (!done.length && !scoped.some((e) => e.pending)) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  const max = Math.max(...done.map((e) => e.latencyMs), 1);
  const avg = done.length ? done.reduce((a, e) => a + e.latencyMs, 0) / done.length : 0;
  const bars = scoped.map((e) => {
    const h = e.latencyMs != null ? Math.max(4, Math.round((e.latencyMs / max) * 100)) : 8;
    const title = e.latencyMs != null
      ? `#${e.seq} ${esc(e.model || "?")} ${fmtMs(e.latencyMs)}`
      : `#${e.seq} ${esc(e.model || "?")} pending`;
    const cls = e.latencyMs != null ? "bar" : "bar pending";
    return `<div class="${cls}" style="height:${h}%" title="${title}"></div>`;
  }).join("");
  const modelNote =
    state.modelFilter !== "all" ? ` · ${esc(state.modelFilter)}` : "";
  box.hidden = false;
  box.innerHTML =
    `<div class="title">Latency trend${modelNote}</div>` +
    `<div class="bars">${bars}</div>` +
    `<div class="meta">avg ${fmtMs(Math.round(avg))} · max ${fmtMs(max)} · ${done.length}/${scoped.length} done</div>`;
}

function updateErrorsBtn() {
  const pool = entriesForModelFilter(state.entries);
  const count = pool.filter((e) => {
    const sc = statusClass(e.status);
    return sc === "4xx" || sc === "5xx" || e.error != null;
  }).length;
  const btn = $("#errorsBtn");
  btn.textContent = `errors (${count})`;
  btn.classList.toggle("on", state.errorsOnly);
}

function renderList() {
  updateErrorsBtn();
  const list = $("#list");
  list.innerHTML = "";
  // Sticky "Live" entry — always at top, opens the streaming timeline.
  const liveRow = el("div", { className: "live-entry" + (state.selected === LIVE ? " sel" : "") + (state.live ? "" : " off") });
  liveRow.append(
    el("div", { className: "top" },
      el("span", { className: "dot" }),
      el("span", { textContent: state.live ? "Live stream" : "Stream (offline)" })),
    el("div", { className: "sub", textContent: state.live ? "All turns, append as they happen" : "Replay saved turns top-to-bottom" })
  );
  liveRow.onclick = () => onPick(LIVE);
  list.append(liveRow);
  const visible = visibleEntries();
  const grouped = groupRetries(visible);
  for (const e of grouped) {
    const sc = e.error ? "5xx" : statusClass(e.status);
    const rowClass = ["row", sc === "4xx" ? "status-4xx" : sc === "5xx" ? "status-5xx" : ""].filter(Boolean).join(" ");
    const row = el("div", { className: rowClass });
    if (e.id === state.selected) row.classList.add("sel");
    if (state.picks.includes(e.id)) row.classList.add("pick");
    const statusTxtClass = sc === "4xx" ? "status-txt-4xx" : sc === "5xx" ? "status-txt-5xx" : (e.pending ? "pending" : "");
    const statusText = e.error ? "transport error" : (e.pending ? "pending…" : "HTTP " + e.status);
    const sub = el("div", { className: "sub" },
      el("span", { className: "time", textContent: e.ts ? new Date(e.ts).toLocaleTimeString() : "" }),
      e.latencyMs != null ? el("span", { className: "latency", textContent: ` ${fmtMs(e.latencyMs)}` }) : null,
      el("span", { textContent: ` ${e.format ? e.format + " · " : ""}${e.nMessages} msg · ${e.nTools} tools · ` }),
      el("span", { className: statusTxtClass, textContent: statusText }));
    if (e.nToolUse) sub.append(el("span", { className: "toolcalls", title: "tool calls in this request", textContent: ` 🔧${e.nToolUse}` }));
    if (e.retries.length) sub.append(el("span", { className: "retry-badge", textContent: ` retried ×${e.retries.length}` }));
    row.append(
      el("div", { className: "top" },
        el("span", { className: "seq", textContent: "#" + e.seq }),
        el("span", { textContent: e.model || "—" })),
      sub
    );
    row.onclick = () => onPick(e.id);
    list.append(row);
  }
}

function onPick(id) {
  if (state.summary) {
    state.summary = false;
    updateSummaryBtn();
  }
  if (state.diff && id !== LIVE) {
    state.picks = state.picks.includes(id) ? state.picks.filter((x) => x !== id) : [...state.picks, id].slice(-2);
    if (state.picks.length === 2) renderDiff();
    renderList();
    return;
  }
  state.selected = id;
  renderList();
  if (id === LIVE) renderLive();
  else loadDetail(id);
}

// ---- detail --------------------------------------------------------------

async function loadDetail(id) {
  const rec = await api("/api/request/" + encodeURIComponent(id));
  state.detail = rec;
  renderDetail();
}

const TABS = ["overview", "flow", "system", "messages", "tools", "response", "headers"];

function renderDetail() {
  const rec = state.detail;
  const d = $("#detail");
  d.innerHTML = "";
  const tabs = el("div", { className: "tabs" });
  for (const t of TABS) {
    const tab = el("div", { className: "tab" + (t === state.tab ? " on" : ""), textContent: t });
    tab.onclick = () => { state.tab = t; renderDetail(); };
    tabs.append(tab);
  }
  d.append(tabs);
  const pane = el("div", { className: "pane" });
  pane.innerHTML = paneHtml(rec, state.tab);
  const curlBtn = pane.querySelector("[data-copy-curl]");
  if (curlBtn) curlBtn.onclick = () => copyCurl(rec, curlBtn);
  d.append(pane);
}

const CURL_SKIP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-connection", "transfer-encoding",
  "upgrade", "te", "trailers", "accept-encoding", "content-length", "host",
]);

function resolveRequestUrl(req) {
  const raw = req?.url || "/";
  if (/^https?:\/\//i.test(raw)) return raw;
  const headers = req?.headers || {};
  const host = headers.host || headers.Host;
  if (!host) return raw;
  const h = String(Array.isArray(host) ? host[0] : host);
  const proto = /^(127\.|localhost|\[::1\])/i.test(h) ? "http" : "https";
  return `${proto}://${h}${raw.startsWith("/") ? raw : `/${raw}`}`;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function buildCurl(rec) {
  const req = rec.request || {};
  const method = (req.method || "GET").toUpperCase();
  const parts = [`curl -sS -X ${method}`, shellQuote(resolveRequestUrl(req))];
  for (const [k, v] of Object.entries(req.headers || {})) {
    if (CURL_SKIP_HEADERS.has(k.toLowerCase())) continue;
    const val = Array.isArray(v) ? v.join(", ") : v;
    if (val == null || val === "") continue;
    parts.push(`-H ${shellQuote(`${k}: ${val}`)}`);
  }
  if (req.body != null && method !== "GET" && method !== "HEAD") {
    const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    parts.push(`-d ${shellQuote(body)}`);
  }
  return parts.join(" \\\n  ");
}

async function copyCurl(rec, btn) {
  const text = buildCurl(rec);
  try {
    await navigator.clipboard.writeText(text);
    const prev = btn.textContent;
    btn.textContent = "copied!";
    setTimeout(() => { btn.textContent = prev; }, 1200);
  } catch {
    window.prompt("Copy curl:", text);
  }
}

function paneHtml(rec, tab) {
  const parsed = rec.parsed || {};
  const view = parsed.view || { system: [], messages: [], tools: [] };
  if (tab === "overview") return overviewHtml(rec, parsed, view);
  if (tab === "flow") return flowHtml(rec);
  if (tab === "system") return blocksHtml(view.system);
  if (tab === "messages") return messagesHtml(view.messages);
  if (tab === "tools") return toolsHtml(view.tools);
  if (tab === "response") return responseHtml(parsed.response);
  if (tab === "headers") return blockEl("headers", JSON.stringify(rec.request?.headers || {}, null, 2));
  return "";
}

function overviewHtml(rec, parsed, view) {
  const c = parsed.cost || {};
  const u = parsed.response?.usage || {};
  const t = rec.timing || {};
  const body = rec.request?.body || {};
  const status = rec.response?.status ?? null;
  const sc = statusClass(status);
  const dl = (f) => `<a class="dl" href="/api/export?id=${encodeURIComponent(rec.id)}&format=${f}">⬇ ${f}</a>`;
  const lat = rec.latencyMs != null ? fmtMs(rec.latencyMs) : "—";
  const ttft = t.ttftMs != null ? fmtMs(t.ttftMs) : "—";
  const gen = t.genMs != null ? fmtMs(t.genMs) : "—";
  const statusCardCls = sc === "5xx" ? "err-card" : sc === "4xx" ? "warn-card" : "";
  const statusCardVal = status != null ? "HTTP " + status : "—";
  const errBody = parsed.response?.error ?? rec.response?.error ?? null;
  const errHtml = errBody
    ? `<div class="block" style="border-color:var(--del)"><div class="h" style="color:var(--del)">error</div><pre style="color:var(--del)">${esc(typeof errBody === "string" ? errBody : JSON.stringify(errBody, null, 2))}</pre></div>`
    : "";
  return `
    <div class="overview-section">Latency</div>
    <div class="cards">
      ${card("total", lat, undefined, "timing-card")}
      ${card("TTFT", ttft, "first byte", "timing-card")}
      ${card("generation", gen, "stream window", "timing-card")}
      ${card("in speed", fmtTps(t.inTps), "pre-1st-byte", "timing-card")}
      ${card("out speed", fmtTps(t.outTps), "after 1st-byte", "timing-card")}
    </div>
    <div class="overview-section">Request</div>
    <div class="cards">
      ${statusCardCls ? card("status", statusCardVal, undefined, statusCardCls) : ""}
      ${card("format", parsed.format || rec.format || "—")}
      ${card("model", body.model || "—")}
      ${card("est. input", "≈" + fmt(parsed.estTokens), "tokens")}
      ${card("actual input", fmt(u.input_tokens), "tokens")}
      ${card("output", fmt(u.output_tokens), "tokens")}
      ${card("cache read", fmt(c.cacheRead), (Math.round((c.cacheHitRate || 0) * 100)) + "% hit")}
      ${card("cache write", fmt(c.cacheWrite), "tokens")}
      ${card("cost", "$" + (c.usd || 0).toFixed(5))}
      ${card("stop", parsed.response?.stop_reason || "—")}
    </div>
    ${errHtml}
    <div class="export-row">${dl("raw")}${dl("md")}${dl("json")}${dl("har")}<button type="button" class="dl copy-curl" data-copy-curl>copy curl</button></div>
    <div class="block"><div class="h">request line</div><pre>${esc(rec.request?.method)} ${esc(rec.request?.url)}</pre></div>
    <p style="color:var(--muted)">${view.system.length} system blocks · ${view.messages.length} messages · ${view.tools.length} tools</p>`;
}

function card(k, v, sub, cls = "") {
  return `<div class="card${cls ? " " + cls : ""}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}${sub ? ` <small>${esc(sub)}</small>` : ""}</div></div>`;
}

function blockEl(label, text, tags = "") {
  return `<div class="block"><div class="h"><span>${esc(label)}</span><span>${tags}</span></div>${preBody(text)}</div>`;
}

function blocksHtml(blocks) {
  if (!blocks.length) return `<p style="color:var(--muted)">none</p>`;
  return blocks.map((b) => blockEl(b.label, b.text, b.cache ? '<span class="tag cache">cache 1h</span>' : "")).join("");
}

// A short, stable hue from a tool-call id so a tool_use and its matching
// tool_result share the same colored stripe and id chip.
function idHue(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

// Long bodies fold into a <details> toggle so the history stays scannable.
// The summary reports the line count; CSS swaps "▸ show N lines" ⇄ "▾ hide"
// as it opens/closes — a plain show/hide toggle, no JS wiring needed.
function preBody(text) {
  const t = text || "";
  const lines = t.split("\n").length;
  const long = t.length > 800 || lines > 18;
  if (!long) return `<pre>${esc(t)}</pre>`;
  return `<details class="fold"><summary><span class="more show">▸ show ${lines} lines</span><span class="more hide">▾ hide</span></summary><pre>${esc(t)}</pre></details>`;
}

function messagesHtml(messages) {
  if (!messages.length) return `<p style="color:var(--muted)">none</p>`;
  return messages.map((m) => {
    const tags = [];
    if (m.cache) tags.push('<span class="tag cache">cache 1h</span>');
    if (m.type === "tool_use") tags.push(`<span class="tag tool">🔧 ${esc(m.name || "tool_use")}</span>`);
    else if (m.type === "tool_result") tags.push(`<span class="tag ${m.isError ? "err" : "result"}">↳ ${m.isError ? "error" : "result"}</span>`);
    else if (m.type && m.type !== "text" && m.type !== "message") tags.push(`<span class="tag tool">${esc(m.type)}</span>`);
    const paired = m.type === "tool_use" || m.type === "tool_result";
    if (paired && m.callId) {
      const hue = idHue(m.callId);
      tags.push(`<span class="tag id" style="background:hsl(${hue} 60% 28%);color:hsl(${hue} 70% 82%)">${esc(String(m.callId).slice(-8))}</span>`);
    }
    const stripe = paired && m.callId ? ` style="border-left:3px solid hsl(${idHue(m.callId)} 60% 45%)"` : "";
    return `<div class="block"${stripe}><div class="h"><span>${esc(m.label)}</span><span>${tags.join("")}</span></div>${preBody(m.text)}</div>`;
  }).join("");
}

function toolsHtml(tools) {
  if (!tools.length) return `<p style="color:var(--muted)">none</p>`;
  return tools.map((t) =>
    `<div class="block"><div class="h"><span>${esc(t.name)}</span></div>` +
    preBody(`${t.description || ""}\n\n— schema —\n${JSON.stringify(t.schema || {}, null, 2)}`) +
    `</div>`
  ).join("");
}

function responseHtml(r) {
  if (!r) return `<p style="color:var(--muted)">no response captured</p>`;
  let html = blockEl("usage", JSON.stringify(r.usage || {}, null, 2), r.streamed ? '<span class="tag tool">streamed</span>' : "");
  for (const b of r.content || []) {
    const label = b.type === "tool_use" ? `tool_use: ${b.name}` : b.type;
    const text = b.type === "tool_use" ? JSON.stringify(b.input, null, 2) : (b.text ?? b.thinking ?? JSON.stringify(b));
    html += blockEl(label, text);
  }
  if (r.error) html += blockEl("error", JSON.stringify(r.error, null, 2));
  return html;
}

// ---- flow: conversation-level sequence diagram ---------------------------
// Reconstructs the agent loop from the parsed messages[] (the full history the
// model was sent) plus this request's response (the model's latest decision,
// not yet folded back into messages). Each tool_use is paired with its
// tool_result by call_id and shares a color, so you can read: model picks a
// tool → CLI executes it locally → result is sent back → model picks again.

const FLOW_ICON = {
  user: "▸", assistant: "✎", thinking: "✻",
  tool_use: "⚙", skill: "🧩", tool_result: "↳", stop: "■",
};

function oneLine(t, n = 100) {
  const s = String(t ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// A Skill tool_use input is { skill, args } — pull the skill name out of it.
function skillName(text) {
  try { const o = JSON.parse(text); return o.skill || o.name || ""; } catch { return ""; }
}

function flowSteps(rec) {
  const parsed = rec.parsed || {};
  const steps = [];
  for (const m of parsed.view?.messages || []) {
    if (m.type === "tool_use") {
      const isSkill = m.name === "Skill";
      steps.push({ kind: isSkill ? "skill" : "tool_use", name: isSkill ? skillName(m.text) || "skill" : m.name, callId: m.callId, text: m.text });
    } else if (m.type === "tool_result") {
      steps.push({ kind: "tool_result", callId: m.callId, isError: m.isError, text: m.text });
    } else if (m.type === "thinking") {
      steps.push({ kind: "thinking", text: m.text });
    } else {
      steps.push({ kind: m.role === "assistant" ? "assistant" : "user", text: m.text });
    }
  }
  // The reply to THIS request lives in the response, not yet in messages[].
  const r = parsed.response;
  if (r && Array.isArray(r.content)) {
    for (const b of r.content) {
      if (b.type === "tool_use") {
        const isSkill = b.name === "Skill";
        steps.push({ kind: isSkill ? "skill" : "tool_use", name: isSkill ? (b.input?.skill || "skill") : b.name, callId: b.id, text: JSON.stringify(b.input ?? {}, null, 2), latest: true });
      } else if (b.type === "thinking") {
        steps.push({ kind: "thinking", text: b.thinking ?? "", latest: true });
      } else {
        steps.push({ kind: "assistant", text: b.text ?? "", latest: true });
      }
    }
    if (r.stop_reason) steps.push({ kind: "stop", text: r.stop_reason });
  }
  return steps;
}

function flowHtml(rec) {
  const steps = flowSteps(rec);
  if (!steps.length) return `<p style="color:var(--muted)">no messages</p>`;
  const tools = rec.parsed?.view?.tools || [];
  const menu = tools.length
    ? `<details class="fold toolmenu"><summary><span class="more show">🛠 ${tools.length} tools offered to the model</span><span class="more hide">🛠 hide tool menu</span></summary><pre>${esc(tools.map((t) => t.name).join("\n"))}</pre></details>`
    : "";

  const rows = steps.map((s) => {
    const paired = s.kind === "tool_use" || s.kind === "skill" || s.kind === "tool_result";
    const hue = s.callId ? ` style="--hue:${idHue(s.callId)}"` : "";
    const tags = [];
    if (s.kind === "skill") tags.push('<span class="tag skill">skill</span>');
    if (s.kind === "tool_result") tags.push(`<span class="tag ${s.isError ? "err" : "result"}">${s.isError ? "error" : "ok"}</span>`);
    if (s.callId) tags.push(`<span class="tag id">${esc(String(s.callId).slice(-6))}</span>`);
    if (s.latest) tags.push('<span class="tag latest">this turn</span>');
    const title =
      s.kind === "tool_use" ? `tool_use → <b>${esc(s.name || "")}</b>` :
      s.kind === "skill" ? `Skill → <b>${esc(s.name || "")}</b>` :
      s.kind === "tool_result" ? "tool_result ↩ executed locally" :
      s.kind === "stop" ? `stop_reason: ${esc(s.text)}` :
      s.kind === "thinking" ? "thinking" : s.kind;
    const body = s.kind === "stop" ? "" :
      `<details class="fold step-body"><summary><span class="prev">${esc(oneLine(s.text))}</span></summary><pre>${esc(s.text)}</pre></details>`;
    return `<div class="step ${s.kind}${paired ? " indent" : ""}"${hue}>` +
      `<span class="dot">${FLOW_ICON[s.kind] || "•"}</span>` +
      `<div class="node"><div class="lead">${title}${tags.join("")}</div>${body}</div></div>`;
  }).join("");

  return `<div class="flow">${menu}<div class="timeline">${rows}</div></div>`;
}

// ---- diff ----------------------------------------------------------------

async function renderDiff() {
  const [a, b] = state.picks;
  const diff = await api(`/api/diff?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
  const d = $("#detail");
  d.innerHTML = "";
  const pane = el("div", { className: "pane" });
  if (diff.error) { pane.innerHTML = `<p>${esc(diff.error)}</p>`; d.append(pane); return; }
  const c = diff.counts;
  pane.innerHTML =
    `<div class="cards">
      ${card("added", "+" + c.added, "blocks")}
      ${card("removed", "−" + c.removed, "blocks")}
      ${card("unchanged", c.common, "blocks")}
      ${card("cached in B", c.cachedInB, "blocks")}
     </div>
     <p style="color:var(--muted)">Comparing <b>${esc(a)}</b> → <b>${esc(b)}</b> (later request B vs earlier A)</p>` +
    `<div class="diff-section add">＋ Added in B (new context this turn)</div>` +
    (diff.added.map((x) => diffBlock(x, "add")).join("") || `<p style="color:var(--muted)">nothing new</p>`) +
    `<div class="diff-section del">− Removed since A</div>` +
    (diff.removed.map((x) => diffBlock(x, "del")).join("") || `<p style="color:var(--muted)">nothing removed</p>`);
  d.append(pane);
}

function diffBlock(x, kind) {
  const tag = x.cache ? '<span class="tag cache">cache</span>' : "";
  return `<div class="block diff-${kind}"><div class="h"><span>${esc(x.label)}</span><span>${tag}</span></div><pre>${esc((x.text || "").slice(0, 4000))}</pre></div>`;
}

// ---- summary: cross-session usage rollup ---------------------------------
// Renders /api/usage (totals + per-model + per-session) as a takeover in
// #detail, peer to the Diff view. Scoped to the current project's roots — see
// readRoots() in src/paths.js — so it rolls up every capture under this cwd,
// not other ccglass projects.

const usd = (n) => "$" + Number(n || 0).toFixed(4);
const pct = (r) => Math.round((r || 0) * 100) + "%";

async function loadUsage() {
  let next;
  try {
    next = await api("/api/usage");
  } catch (err) {
    next = { error: String(err?.message || err) };
  }
  // Race guard: user may have toggled Summary off mid-fetch. Drop the result
  // so we don't clobber #detail with stale rollup data.
  if (!state.summary) return;
  state.usage = next;
  renderSummary();
}

function renderSummary() {
  const d = $("#detail");
  d.innerHTML = "";
  const u = state.usage;
  if (!u) { d.innerHTML = '<div class="empty">Loading\u2026</div>'; return; }
  if (u.error) { d.innerHTML = `<div class="empty">Failed to load usage: ${esc(u.error)}</div>`; return; }
  if (!u.sessionCount) { d.innerHTML = '<div class="empty">No captured sessions yet for this project.</div>'; return; }

  const t = u.totals;
  const range = [u.range?.from, u.range?.to].filter(Boolean).map((s) => new Date(s).toLocaleString()).join(" \u2192 ") || "\u2014";
  const unmeasured = u.unmeasured ? `${u.unmeasured} unmeasured` : undefined;
  const cardsHtml = `
    <div class="overview-section">Totals across ${fmt(u.sessionCount)} sessions</div>
    <div class="cards">
      ${card("sessions", fmt(u.sessionCount))}
      ${card("requests", fmt(u.requestCount), unmeasured)}
      ${card("input", fmt(t.input), "tokens")}
      ${card("output", fmt(t.output), "tokens")}
      ${card("cache read", fmt(t.cacheRead), pct(t.cacheHitRate) + " hit")}
      ${card("cache write", fmt(t.cacheWrite), "tokens")}
      ${card("cost", usd(t.usd))}
    </div>
    <p style="color:var(--muted)">range: ${esc(range)}</p>`;

  const subTabs = [["byModel", "by model"], ["bySession", "by session"]];
  const tabsHtml = `<div class="tabs">` + subTabs.map(([id, label]) =>
    `<div class="tab${id === state.summaryTab ? " on" : ""}" data-stab="${id}">${label}</div>`
  ).join("") + `</div>`;

  const body = state.summaryTab === "bySession"
    ? bySessionHtml(u.bySession)
    : byModelHtml(u.byModel);

  d.innerHTML = `${tabsHtml}<div class="pane">${cardsHtml}<div class="summary-body">${body}</div></div>`;
  d.querySelectorAll(".tab[data-stab]").forEach((node) => {
    node.onclick = () => { state.summaryTab = node.dataset.stab; renderSummary(); };
  });
}

function byModelHtml(rows) {
  if (!rows?.length) return `<p style="color:var(--muted)">no measured requests</p>`;
  const head = `<tr><th>model</th><th class="n">reqs</th><th class="n">input</th><th class="n">output</th><th class="n">cache read</th><th class="n">cache hit</th><th class="n">cost</th></tr>`;
  const body = rows.map((r) =>
    `<tr><td>${esc(r.model)}</td><td class="n">${fmt(r.requests)}</td><td class="n">${fmt(r.input)}</td><td class="n">${fmt(r.output)}</td><td class="n">${fmt(r.cacheRead)}</td><td class="n">${pct(r.cacheHitRate)}</td><td class="n">${usd(r.usd)}</td></tr>`
  ).join("");
  return `<table class="usage-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function bySessionHtml(rows) {
  if (!rows?.length) return `<p style="color:var(--muted)">no sessions</p>`;
  const head = `<tr><th>session</th><th class="n">reqs</th><th class="n">input</th><th class="n">output</th><th class="n">cache hit</th><th class="n">cost</th></tr>`;
  const body = rows.map((r) =>
    `<tr><td>${esc(r.session)}</td><td class="n">${fmt(r.requests)}</td><td class="n">${fmt(r.input)}</td><td class="n">${fmt(r.output)}</td><td class="n">${pct(r.cacheHitRate)}</td><td class="n">${usd(r.usd)}</td></tr>`
  ).join("");
  return `<table class="usage-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function updateSummaryBtn() {
  const btn = $("#summaryBtn");
  btn.textContent = "Summary: " + (state.summary ? "on" : "off");
  btn.classList.toggle("on", state.summary);
}

// SSE-driven entries arrive while Summary is open; reload the rollup
// (debounced) so totals don't go stale during a live session.
let usageReloadTimer = null;
function scheduleUsageReload() {
  if (!state.summary) return;
  clearTimeout(usageReloadTimer);
  usageReloadTimer = setTimeout(() => { if (state.summary) loadUsage(); }, 500);
}

// ---- live stream view ----------------------------------------------------
// Single-column timeline rendered into #detail. Walks every entry in the
// current session in order, expands each via flowSteps(), dedups across
// entries by callId/text-prefix, and merges each tool_use ↔ its tool_result
// into one row (body shows the OUTPUT; original input tucks into a nested
// "show input" disclosure). SSE appends new steps to the live view without
// re-rendering everything.

function smartSummary(step) {
  if (step.kind === "tool_result") {
    let inner = String(step.text || "");
    try {
      const o = JSON.parse(inner);
      if (Array.isArray(o)) inner = o.map((x) => typeof x === "string" ? x : (x?.text ?? JSON.stringify(x))).join("\n");
      else if (typeof o === "object" && o) inner = o.text ?? JSON.stringify(o);
    } catch { /* not JSON */ }
    return oneLine(inner, 140);
  }
  if (step.kind === "stop") return step.text || "";
  if (step.kind === "tool_use" || step.kind === "skill") {
    let input = {};
    try { input = JSON.parse(step.text); } catch { /* not JSON */ }
    const name = step.name || "";
    if (name === "Bash") return oneLine(input.command, 140);
    if (name === "Read") {
      const loc = input.file_path || "";
      const rng = input.offset != null ? `:${input.offset}${input.limit ? `-${input.offset + input.limit}` : ""}` : "";
      return loc + rng;
    }
    if (name === "Edit" || name === "Write" || name === "NotebookEdit") return oneLine(input.file_path, 140);
    if (name === "Grep") return [input.pattern && `"${input.pattern}"`, input.path].filter(Boolean).join(" in ");
    if (name === "Glob") return input.pattern || "";
    if (name === "WebFetch" || name === "WebSearch") return oneLine(input.url || input.query, 140);
    if (name === "Skill") return input.skill || input.name || "";
    if (name === "TaskCreate" || name === "TaskUpdate") return oneLine(input.subject || input.description, 140);
    if (name === "AskUserQuestion") return oneLine(input.questions?.[0]?.question, 140);
    if (/sql|query|exec/i.test(name)) return oneLine(input.sql || input.query || input.statement, 140);
    const firstScalar = Object.values(input).find((v) => typeof v === "string" || typeof v === "number");
    if (firstScalar != null) return oneLine(firstScalar, 140);
    return oneLine(step.text, 140);
  }
  return oneLine(step.text, 200);
}

function liveStepKey(s) {
  if (s.callId) return s.kind + "|" + s.callId;
  return s.kind + "|" + (s.text || "").slice(0, 200);
}

// Tool name → category (file/shell/search/web/task/agent/plan/q&a/cron/notify/mcp)
function toolCategory(name) {
  if (!name) return null;
  if (name.startsWith("mcp__")) return "mcp";
  if (/^(Read|Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return "file";
  if (/^(Bash|BashOutput|KillShell)$/.test(name)) return "shell";
  if (/^(Grep|Glob|LS)$/.test(name)) return "search";
  if (/^(WebFetch|WebSearch)$/.test(name)) return "web";
  if (/^Task(Create|Update|Get|List|Output|Stop)$/.test(name)) return "task";
  if (/^Agent$/.test(name)) return "agent";
  if (/^Skill$/.test(name)) return "skill";
  if (/^(EnterPlanMode|ExitPlanMode)$/.test(name)) return "plan";
  if (/^AskUserQuestion$/.test(name)) return "ask";
  if (/^(ScheduleWakeup|CronCreate|CronDelete|CronList)$/.test(name)) return "cron";
  if (/^PushNotification$/.test(name)) return "notify";
  if (/^TodoWrite$/.test(name)) return "task";
  return null;
}

// Recognize common envelope patterns in flow steps and return pattern tags.
// These are passive labels — they don't filter, just classify, so you can scan
// the stream and see "ah, this user row is a system-reminder, not a real input".
const PAT_DETECTORS = [
  // ---- user-side text envelopes ----------------------------------------
  { kinds: ["user"], match: (t) => /^<command-name>|^<command-message>|^<command-args>/m.test(t), tag: "slash" },
  { kinds: ["user"], match: (t) => /<local-command-stdout>/.test(t), tag: "cmd-out" },
  { kinds: ["user"], match: (t) => /<user-prompt-submit-hook>|<session-start-hook>|<post-tool-use-hook>|<stop-hook>/.test(t), tag: "hook" },
  { kinds: ["user"], match: (t) => /<system-reminder>/.test(t), tag: "reminder" },
  { kinds: ["user"], match: (t) => /Caveat: The messages below were generated/i.test(t), tag: "caveat" },
  { kinds: ["user"], match: (t) => /\[Image #\d+\]|image_path=|<channel source="(imessage|telegram)"/.test(t), tag: "image" },
  { kinds: ["user"], match: (t) => /Contents of \/.+CLAUDE\.md|Codebase and user instructions are shown below|# auto memory|# currentDate|# userEmail/.test(t), tag: "memory" },
  { kinds: ["user"], match: (t) => /Previous Conversation Compacted|This session is being continued|<auto-compact-summary>|stepped away and is coming back|Recap in under \d+ words|recap.*1-2 plain sentences/i.test(t), tag: "recap" },
  // Skill invocation/return — appears as user-role text in Claude Code
  { kinds: ["user"], match: (t) => /^Launching skill:|^Base directory for this skill:/m.test(t), tag: "skill-load" },
  // ---- assistant-side text -----------------------------------------------
  { kinds: ["assistant"], match: (t, s) => s.text && s.text.length === 0, tag: "empty" },
];

function detectPatterns(step) {
  const out = [];
  const t = String(step.text || "");
  for (const d of PAT_DETECTORS) {
    if (!d.kinds.includes(step.kind)) continue;
    try { if (d.match(t, step)) out.push(d.tag); } catch { /* skip */ }
  }
  if (step.kind === "tool_use" || step.kind === "skill") {
    const cat = toolCategory(step.name);
    if (cat) out.push(cat);
  }
  return out;
}

// Rich tag metadata. `headline` is shown as the popover title; `desc` is a 2-4
// sentence explanation rendered in the popover body. `doc` adds an "Open docs"
// footer link. The popover replaces the native title tooltip entirely.
const TAG_INFO = {
  // ---- pattern tags: user-side envelopes -------------------------------
  reminder: {
    headline: "system-reminder",
    desc: "A <system-reminder> block — the CLI injected guidance into the user's message slot to nudge the model (e.g. 'consider using the task tools', 'be terse', 'auto-mode active'). The user didn't type this; it's harness instrumentation. Models are trained to take these seriously, so they shape behavior even though they're invisible in normal chat UIs.",
  },
  hook: {
    headline: "hook output",
    desc: "Output from a Claude Code hook — user-configured shell commands that fire on lifecycle events (session start, user prompt submit, after each tool use, on stop). Whatever the hook prints to stdout gets injected as a synthetic user-role message. The model treats it as user input, so a misbehaving hook can effectively steer the agent.",
    doc: "https://docs.claude.com/en/docs/claude-code/hooks",
  },
  slash: {
    headline: "slash command",
    desc: "The user typed a slash command like /skill-name, /clear, or /help. The CLI resolves it into a structured envelope (<command-name>, <command-message>, <command-args>) before sending to the model — that envelope is what you see in the body.",
    doc: "https://docs.claude.com/en/docs/claude-code/slash-commands",
  },
  "cmd-out": {
    headline: "local command output",
    desc: "stdout of a local shell command the user ran inline via the ! prefix (e.g. `!ls`). The CLI wraps it in <local-command-stdout> tags and feeds it back to the model as user-role context.",
  },
  caveat: {
    headline: "caveat banner",
    desc: "The CLI prepends 'Caveat: The messages below were generated by the user while running local commands' when content was produced by side-channel tools (file edits via /edit, etc), not the assistant. Marks a provenance boundary.",
  },
  memory: {
    headline: "memory context",
    desc: "The CLI's auto-loaded context: CLAUDE.md files (project + user-level), environment info (cwd, OS, git branch), current date, user email. This bootstraps every session and usually lives in the first user message — explains why turn 1 is huge.",
    doc: "https://docs.claude.com/en/docs/claude-code/memory",
  },
  recap: {
    headline: "recap",
    desc: "A synthetic message asking the model to compress or restate prior state. Two common triggers: (1) auto-compaction — the CLI hit the context window and condensed earlier turns into a summary, so the model continues from a digest rather than full history; (2) the user stepped away and came back, and the harness injects a 'recap where we are' prompt to re-orient the model.",
  },
  image: {
    headline: "image attached",
    desc: "The user attached an image (screenshot, IM channel photo, drag-and-drop). The body shows the surrounding text; the image itself was sent as a separate content block alongside.",
  },
  "skill-load": {
    headline: "skill loaded",
    desc: "A Skill's full instructions were dropped into the conversation. Once loaded, the skill's content acts as additional system-level guidance for the rest of the turn (sometimes longer). Usually preceded by a slash-command invocation.",
    doc: "https://docs.claude.com/en/docs/claude-code/skills",
  },
  empty: {
    headline: "empty block",
    desc: "An empty text content block — no characters. Harmless but odd; usually a model output quirk.",
  },
  // ---- pattern tags: tool categories ------------------------------------
  file: {
    headline: "file operation",
    desc: "Read / Edit / Write / MultiEdit / NotebookEdit — the model is touching files on disk. The body shows the file content after a successful call.",
  },
  shell: {
    headline: "shell command",
    desc: "Bash — the model executed a shell command locally. The title shows the command; the body shows stdout (and stderr) plus exit code.",
  },
  search: {
    headline: "codebase search",
    desc: "Grep (regex over files) or Glob (filename patterns). The model is exploring the codebase. Output is typically a short list of matches with line numbers.",
  },
  web: {
    headline: "web access",
    desc: "WebFetch (load a URL and summarize) or WebSearch (query a search engine). The model went off-machine to get context.",
  },
  task: {
    headline: "task tracking",
    desc: "TaskCreate / TaskUpdate / TaskList / TodoWrite — the model is managing its own to-do list for multi-step work. Visible in the CLI's spinner.",
  },
  agent: {
    headline: "sub-agent",
    desc: "Spawned a specialized sub-agent via the Agent tool. The sub-agent runs in an isolated context and returns a single summary message. Useful for parallel exploration without polluting the main context.",
    doc: "https://docs.claude.com/en/docs/claude-code/sub-agents",
  },
  skill: {
    headline: "skill",
    desc: "Invoked a Claude skill via the Skill tool. The skill's instructions get loaded and the model follows that workflow.",
    doc: "https://docs.claude.com/en/docs/claude-code/skills",
  },
  plan: {
    headline: "plan mode",
    desc: "EnterPlanMode / ExitPlanMode — the model is in plan-first mode, where it must present an implementation plan and get user approval before writing code. Common for non-trivial features.",
  },
  ask: {
    headline: "user question",
    desc: "AskUserQuestion — the model paused execution to ask the user a multiple-choice question. Conversation can't continue until the user answers.",
  },
  cron: {
    headline: "scheduled",
    desc: "CronCreate / CronDelete / CronList / ScheduleWakeup — the model scheduled a future prompt. The harness fires the prompt back at the scheduled time, resuming the loop.",
  },
  notify: {
    headline: "notification",
    desc: "PushNotification — the model sent a desktop and/or phone notification to grab the user's attention. Usually for long-running tasks or when blocked.",
  },
  mcp: {
    headline: "MCP tool",
    desc: "Model Context Protocol — the model called a tool exposed by an external MCP server (e.g. mcp__github__*, mcp__filesystem__*). MCP is how Claude Code plugs into databases, APIs, IDEs.",
    doc: "https://docs.claude.com/en/docs/claude-code/mcp",
  },
  // ---- operational tags -------------------------------------------------
  ok: {
    headline: "ok",
    desc: "The tool call returned successfully. The body shows the exact output text the model received — that's what the model will reason about next.",
  },
  err: {
    headline: "error",
    desc: "The tool reported an error (non-zero exit code, exception, validation failure, refusal). The body shows the error text the model saw — it may retry with a different approach or surface the failure to the user.",
  },
  pending: {
    headline: "pending",
    desc: "The model asked for this tool call but its tool_result hasn't arrived yet. Either the tool is still running locally (Bash command, network fetch), or this was the very last action in the captured trace and the CLI hasn't sent the next request.",
  },
  latest: {
    headline: "this turn",
    desc: "This step belongs to the assistant's response of the most recent HTTP round-trip. Earlier rows are reconstructed from prior conversation history; this one came in just now over the wire.",
  },
  id: {
    headline: "call id",
    desc: "Tool-call ID assigned by the model when it requested the tool. ccglass uses it to pair a tool_use row with its matching tool_result — they share the same colored left stripe so you can read across.",
  },
};

// Render a tag chip. `name` is the lookup key in TAG_INFO; `label` is the
// visible text (defaults to name). Popover content comes from TAG_INFO via
// data-tag-key — no native title attribute, so the rich popover is the only
// hover affordance.
function tagChip(name, extraClass = "", label = name) {
  const cls = "tag " + (extraClass ? extraClass + " " : "");
  return `<span class="${cls}" data-tag-key="${esc(name)}">${esc(label)}</span>`;
}

// ---- tag popover ---------------------------------------------------------
// A single shared popover element shown on hover over any [data-tag-key].
// Body-level positioning means it works whether the tag is in the live pane,
// the classic detail, or anywhere else. Hovering the popover itself keeps it
// open so users can click the docs link.

(function setupTagPopover() {
  const el = document.createElement("div");
  el.className = "tag-popover";
  el.hidden = true;
  document.body.appendChild(el);

  let showT = null, hideT = null, current = null;

  function scheduleHide() {
    clearTimeout(hideT);
    hideT = setTimeout(() => { el.hidden = true; current = null; }, 150);
  }

  function show(target) {
    clearTimeout(hideT);
    if (current === target) return;
    clearTimeout(showT);
    showT = setTimeout(() => {
      const key = target.dataset.tagKey;
      const info = TAG_INFO[key];
      if (!info) return;
      el.innerHTML =
        `<div class="pop-head">${esc(info.headline || key)}</div>` +
        `<div class="pop-body">${esc(info.desc || "")}</div>` +
        (info.doc ? `<div class="pop-doc"><a href="${esc(info.doc)}" target="_blank" rel="noopener">Open docs ↗</a></div>` : "");
      el.hidden = false;
      position(target);
      current = target;
    }, 200);
  }

  function position(target) {
    const r = target.getBoundingClientRect();
    // Reset to measure natural size
    el.style.left = "-9999px";
    el.style.top = "0px";
    const pr = el.getBoundingClientRect();
    let left = r.left;
    let top = r.bottom + 6;
    if (left + pr.width > window.innerWidth - 8) left = window.innerWidth - pr.width - 8;
    if (left < 8) left = 8;
    if (top + pr.height > window.innerHeight - 8) top = Math.max(8, r.top - pr.height - 6);
    el.style.left = left + "px";
    el.style.top = top + "px";
  }

  el.addEventListener("mouseenter", () => clearTimeout(hideT));
  el.addEventListener("mouseleave", scheduleHide);

  // Event delegation — any element with data-tag-key triggers
  document.addEventListener("mouseover", (e) => {
    const t = e.target.closest("[data-tag-key]");
    if (!t) return;
    show(t);
  });
  document.addEventListener("mouseout", (e) => {
    const t = e.target.closest("[data-tag-key]");
    if (!t) return;
    scheduleHide();
  });
  // Escape closes immediately
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { el.hidden = true; current = null; } });
})();

function liveStepEl(step, { latestEntry = false } = {}) {
  const paired = step.kind === "tool_use" || step.kind === "skill" || step.kind === "tool_result";
  const hasBody = step.kind !== "stop" && (step.text != null && String(step.text).length > 0);

  const root = document.createElement(hasBody ? "details" : "div");
  root.className = "flowrow " + step.kind + (paired ? " paired" : "");
  if (hasBody) root.open = step.kind !== "thinking"; // thinking starts collapsed
  if (step.callId) {
    root.style.setProperty("--hue", idHue(step.callId));
    root.dataset.callId = step.callId;
  }

  const tags = [];
  // Pattern tags first (left-most) — classify what kind of envelope this row is
  for (const p of detectPatterns(step)) tags.push(tagChip(p, `pat pat-${p}`));
  if (step.kind === "skill") tags.push(tagChip("skill", "skill"));
  if (step.kind === "tool_result") tags.push(tagChip(step.isError ? "err" : "ok", step.isError ? "err" : "ok"));
  if (step.callId) {
    const short = esc(String(step.callId).slice(-6));
    tags.push(`<span class="tag id" data-tag-key="id">${short}</span>`);
  }
  if (latestEntry && step.latest) tags.push(tagChip("latest", "latest", "this turn"));
  if (step.kind === "tool_use" || step.kind === "skill") {
    tags.push(`<span class="tag pending" data-tag-key="pending">pending…</span>`);
  }

  const titleHtml =
    step.kind === "tool_use" ? `<b>${esc(step.name || "tool")}</b>` :
    step.kind === "skill" ? `<b>/${esc(step.name || "skill")}</b>` :
    step.kind === "tool_result" ? `<span style="color:var(--muted)">result</span>` :
    step.kind === "stop" ? `<span style="color:var(--muted)">stop_reason</span>` :
    step.kind === "thinking" ? `<span style="color:var(--muted)">thinking</span>` :
    step.kind === "user" ? `<b>user</b>` :
    step.kind === "assistant" ? `<b>assistant</b>` : `<span style="color:var(--muted)">${esc(step.kind)}</span>`;

  const sumText = smartSummary(step);
  const summaryHtml = (step.kind !== "stop" && sumText) ? `<span class="summary">${esc(sumText)}</span>` : "";
  const inlineHtml = step.kind === "stop" ? `<span class="inline">${esc(step.text || "")}</span>` : "";
  const toggleHtml = hasBody ? `<span class="toggle" aria-hidden="true"></span>` : "";

  const headHtml =
    `<span class="dot">${FLOW_ICON[step.kind] || "•"}</span>` +
    `<span class="lead">${titleHtml}${summaryHtml}${inlineHtml}${tags.join("")}${toggleHtml}</span>`;

  if (hasBody) {
    root.innerHTML = `<summary>${headHtml}</summary><pre class="body input-body">${esc(step.text || "")}</pre>`;
    if (step.kind === "tool_use" || step.kind === "skill") root.dataset.input = step.text || "";
  } else {
    root.innerHTML = headHtml;
  }
  return root;
}

function liveMergeResult(toolRow, resultStep) {
  toolRow.classList.add("has-output"); // CSS keeps the title-line summary visible (command/path) since it's now distinct from the body (output)
  const lead = toolRow.querySelector(".lead");
  if (lead) {
    const pending = lead.querySelector(".tag.pending");
    if (pending) pending.remove();
    const okErrKey = resultStep.isError ? "err" : "ok";
    const okErr = document.createElement("span");
    okErr.className = "tag " + okErrKey;
    okErr.textContent = okErrKey;
    okErr.dataset.tagKey = okErrKey;
    const tog = lead.querySelector(".toggle");
    if (tog) lead.insertBefore(okErr, tog); else lead.appendChild(okErr);
  }
  const oldBody = toolRow.querySelector(":scope > .body");
  if (oldBody) oldBody.remove();
  const output = document.createElement("pre");
  output.className = "body output-body";
  output.textContent = resultStep.text || "";
  toolRow.appendChild(output);
  const inputText = toolRow.dataset.input || "";
  if (inputText && inputText.trim() !== "{}" && inputText.length > 4) {
    const inputFold = document.createElement("details");
    inputFold.className = "input-fold";
    inputFold.innerHTML = `<summary>show input</summary><pre>${esc(inputText)}</pre>`;
    toolRow.appendChild(inputFold);
  }
}

function liveTurnSepEl(meta) {
  const div = document.createElement("div");
  div.className = "turn-sep";
  const errClass = meta.status && meta.status >= 400 ? " err" : "";
  const clock = meta.ts ? new Date(meta.ts).toTimeString().slice(0, 8) : "";
  div.innerHTML =
    `<span class="meta">` +
      `<b>turn ${meta.seq ?? ""}</b>` +
      (meta.model ? `<span>${esc(meta.model)}</span>` : "") +
      (meta.latencyMs != null ? `<span>${fmtMs(meta.latencyMs)}</span>` : "") +
      (meta.status != null ? `<span class="${errClass.trim()}">${meta.status}</span>` : "") +
      (clock ? `<span>${clock}</span>` : "") +
    `</span>`;
  return div;
}

function liveBodyEl() {
  return $("#detail .live-pane .live-body");
}

function liveAppendEntry(rec, { flash = false } = {}) {
  const body = liveBodyEl();
  if (!body) return;
  const steps = flowSteps(rec);
  let appendedAny = false;
  for (const s of steps) {
    // tool_result: merge into existing tool_use row instead of new row
    if (s.kind === "tool_result" && s.callId && state.liveToolRows.has(s.callId)) {
      const mergeKey = "merged|" + s.callId;
      if (state.liveSeen.has(mergeKey)) continue;
      state.liveSeen.set(mergeKey, true);
      liveMergeResult(state.liveToolRows.get(s.callId), s);
      continue;
    }
    const k = liveStepKey(s);
    if (state.liveSeen.has(k)) continue;
    state.liveSeen.set(k, true);
    if (!appendedAny) {
      body.appendChild(liveTurnSepEl({
        seq: rec.seq, model: rec.parsed?.view?.model || rec.model,
        latencyMs: rec.latencyMs, status: rec.response?.status, ts: rec.ts ?? rec.startedAt,
      }));
      appendedAny = true;
    }
    const row = liveStepEl(s, { latestEntry: true });
    if (flash) row.classList.add("flash");
    body.appendChild(row);
    if ((s.kind === "tool_use" || s.kind === "skill") && s.callId) {
      state.liveToolRows.set(s.callId, row);
    }
  }
  if (state.livePinned) {
    const pane = $("#detail .live-pane");
    if (pane) {
      // Mark this as programmatic so the scroll handler doesn't mis-interpret
      // the follow-up scroll event as the user scrolling away from bottom.
      state.programmaticScrollAt = Date.now();
      pane.scrollTop = pane.scrollHeight;
    }
  }
}

async function renderLive() {
  state.liveSeen.clear();
  state.liveToolRows.clear();
  state.livePinned = true;

  const d = $("#detail");
  d.innerHTML =
    `<div class="live-pane">` +
      `<div class="live-toolbar">` +
        `<label><input type="checkbox" id="liveAutoScroll" checked /> auto-scroll</label>` +
        `<button id="liveExpandAll">expand all</button>` +
        `<button id="liveCollapseAll">collapse all</button>` +
        `<span class="spacer"></span>` +
        `<span class="muted">turns append as they arrive · click a request on the left for the classic per-call view</span>` +
      `</div>` +
      `<div class="live-body"></div>` +
    `</div>`;

  const pane = $("#detail .live-pane");
  pane.addEventListener("scroll", () => {
    // Ignore scroll events fired by our own scrollTop assignment during
    // rapid appends — only react to genuine user scrolls.
    if (Date.now() - (state.programmaticScrollAt || 0) < 200) return;
    const nearBottom = pane.scrollHeight - pane.clientHeight - pane.scrollTop < 40;
    state.livePinned = nearBottom;
    const cb = $("#liveAutoScroll");
    if (cb) cb.checked = nearBottom;
  });
  $("#liveAutoScroll").onchange = (e) => { state.livePinned = e.target.checked; };
  $("#liveExpandAll").onclick = () => { for (const r of pane.querySelectorAll("details.flowrow")) r.open = true; };
  $("#liveCollapseAll").onclick = () => { for (const r of pane.querySelectorAll("details.flowrow")) r.open = false; };

  // Walk every entry in order, fetch its full record, append flow steps.
  const entries = entriesForModelFilter(state.entries).slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
  for (const e of entries) {
    try {
      const rec = await api("/api/request/" + encodeURIComponent(e.id));
      if (rec && !rec.error) liveAppendEntry(rec);
    } catch { /* skip on error */ }
  }
  if (state.livePinned) {
    state.programmaticScrollAt = Date.now();
    pane.scrollTop = pane.scrollHeight;
  }
}

// ---- live + wiring -------------------------------------------------------

function connectStream() {
  try {
    const es = new EventSource("/api/stream");
    es.onmessage = async (ev) => {
      const s = JSON.parse(ev.data);
      if (s.session !== (state.session || state.live)) return;
      const i = state.entries.findIndex((e) => e.id === s.id);
      if (i >= 0) state.entries[i] = s;
      else state.entries.push(s);
      renderModelFilter();
      renderLatencyTrend();
      renderList();
      clearDetailIfHidden();
      if (state.selected === LIVE) {
        try {
          const rec = await api("/api/request/" + encodeURIComponent(s.id));
          if (rec && !rec.error) liveAppendEntry(rec, { flash: true });
        } catch { /* ignore */ }
      } else if (!state.summary && s.id === state.selected) {
        loadDetail(s.id);
      }
      if (!s.pending) loadSessionStatsQuiet();
      if (state.summary && !s.pending) scheduleUsageReload();
    };
  } catch {}
}

async function loadSessionStatsQuiet() {
  if (!state.session) return;
  const stats = await api("/api/session-stats?" + sessionStatsQuery());
  applySessionStats(stats);
  renderModelFilter();
  renderSessionStats();
}

$("#session").onchange = async (e) => {
  state.session = e.target.value;
  state.picks = [];
  state.modelFilter = "all";
  await loadList();
  if (state.selected === LIVE) renderLive();
};
$("#modelFilter").onchange = (e) => {
  state.modelFilter = e.target.value;
  loadSessionStatsQuiet();
  renderLatencyTrend();
  renderList();
  clearDetailIfHidden();
  if (state.selected === LIVE) renderLive();
};
$("#errorsBtn").onclick = () => { state.errorsOnly = !state.errorsOnly; renderList(); };
$("#diffBtn").onclick = (e) => {
  state.diff = !state.diff;
  state.picks = [];
  e.target.textContent = "Diff: " + (state.diff ? "pick 2" : "off");
  e.target.classList.toggle("on", state.diff);
  // Diff and Summary both swap #detail \u2014 only one can be active.
  if (state.diff && state.summary) {
    state.summary = false;
    updateSummaryBtn();
    // Summary HTML is still in #detail; restore the per-request view (or
    // empty state) so the user isn't left staring at a stale rollup.
    if (state.selected === LIVE) renderLive();
    else if (state.selected) loadDetail(state.selected);
    else $("#detail").innerHTML = '<div class="empty">Select a request, or start chatting in Claude Code.</div>';
  }
  renderList();
  if (!state.diff && state.selected) {
    if (state.selected === LIVE) renderLive();
    else loadDetail(state.selected);
  }
};
$("#summaryBtn").onclick = () => {
  state.summary = !state.summary;
  if (state.summary) {
    // Mirror image of the Diff toggle: turning Summary on cancels Diff.
    if (state.diff) {
      state.diff = false;
      state.picks = [];
      const db = $("#diffBtn");
      db.textContent = "Diff: off";
      db.classList.remove("on");
      renderList();
    }
    updateSummaryBtn();
    // Drop the prior payload so renderSummary() falls through to "Loading…"
    // instead of flashing yesterday's totals before the fetch lands.
    state.usage = null;
    renderSummary();
    loadUsage();
  } else {
    updateSummaryBtn();
    if (state.selected === LIVE) renderLive();
    else if (state.selected) loadDetail(state.selected);
    else $("#detail").innerHTML = '<div class="empty">Select a request, or start chatting in Claude Code.</div>';
  }
};

const themeCtl = window.ccglassTheme?.initTheme?.();
const themeSelect = $("#themeSelect");
if (themeCtl && themeSelect) {
  themeSelect.value = themeCtl.getMode();
  themeSelect.onchange = () => themeCtl.setMode(themeSelect.value);
}

loadSessions().then(connectStream);
