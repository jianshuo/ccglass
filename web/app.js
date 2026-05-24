// ccglass dashboard SPA. Vanilla JS, no build step.

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const fmt = (n) => (n == null ? "—" : n.toLocaleString());

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

const state = { session: null, live: null, entries: [], selected: null, tab: "overview", diff: false, picks: [], errorsOnly: false };

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
}

async function loadList() {
  if (!state.session) return;
  const { entries } = await api("/api/requests?session=" + encodeURIComponent(state.session));
  state.entries = entries;
  renderList();
}

function updateErrorsBtn() {
  const count = state.entries.filter((e) => {
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
  let visible = state.entries;
  if (state.errorsOnly) {
    visible = visible.filter((e) => {
      const sc = statusClass(e.status);
      return sc === "4xx" || sc === "5xx" || e.error != null;
    });
  }
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
  if (state.diff) {
    state.picks = state.picks.includes(id) ? state.picks.filter((x) => x !== id) : [...state.picks, id].slice(-2);
    if (state.picks.length === 2) renderDiff();
    renderList();
    return;
  }
  state.selected = id;
  renderList();
  loadDetail(id);
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
  d.append(pane);
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
  const body = rec.request?.body || {};
  const status = rec.response?.status ?? null;
  const sc = statusClass(status);
  const dl = (f) => `<a class="dl" href="/api/export?id=${encodeURIComponent(rec.id)}&format=${f}">⬇ ${f}</a>`;
  const statusCardCls = sc === "5xx" ? "err-card" : sc === "4xx" ? "warn-card" : "";
  const statusCardVal = status != null ? "HTTP " + status : "—";
  const errBody = parsed.response?.error ?? rec.response?.error ?? null;
  const errHtml = errBody
    ? `<div class="block" style="border-color:var(--del)"><div class="h" style="color:var(--del)">error</div><pre style="color:var(--del)">${esc(typeof errBody === "string" ? errBody : JSON.stringify(errBody, null, 2))}</pre></div>`
    : "";
  return `
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
    <div>${dl("raw")}${dl("md")}${dl("json")}${dl("har")}</div>
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

// ---- live + wiring -------------------------------------------------------

function connectStream() {
  try {
    const es = new EventSource("/api/stream");
    es.onmessage = (ev) => {
      const s = JSON.parse(ev.data);
      if (s.session !== (state.session || state.live)) return;
      const i = state.entries.findIndex((e) => e.id === s.id);
      if (i >= 0) state.entries[i] = s;
      else state.entries.push(s);
      renderList();
      if (s.id === state.selected) loadDetail(s.id);
    };
  } catch {}
}

$("#session").onchange = (e) => { state.session = e.target.value; state.picks = []; loadList(); };
$("#errorsBtn").onclick = () => { state.errorsOnly = !state.errorsOnly; renderList(); };
$("#diffBtn").onclick = (e) => {
  state.diff = !state.diff;
  state.picks = [];
  e.target.textContent = "Diff: " + (state.diff ? "pick 2" : "off");
  e.target.classList.toggle("on", state.diff);
  renderList();
  if (!state.diff && state.selected) loadDetail(state.selected);
};

loadSessions().then(connectStream);
