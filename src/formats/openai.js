// OpenAI adapter: handles both the Responses API (/v1/responses, used by Codex)
// and Chat Completions (/v1/chat/completions). Normalizes requests, streamed
// responses, usage, and cost into the same shape the dashboard expects.

import { estimateTokens } from "../tokens.js";

// ---- request → normalized view ------------------------------------------

function flatten(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : p.text ?? p.input_text ?? p.output_text ?? (p.type ? `[${p.type}]` : JSON.stringify(p))))
      .join("");
  }
  return JSON.stringify(content);
}

// Tool-call arguments arrive as a JSON string; pretty-print when parseable.
function prettyArgs(args) {
  if (args == null) return "";
  if (typeof args !== "string") return JSON.stringify(args, null, 2);
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

function toolView(t) {
  const f = t.function || t;
  return { name: f.name, description: f.description || "", schema: f.parameters || f.input_schema || {} };
}

function isResponses(body = {}) {
  return body.input !== undefined || body.instructions !== undefined;
}

export const openai = {
  name: "openai",

  summary(body = {}) {
    const items = isResponses(body) ? body.input : body.messages;
    return {
      model: body.model,
      nMessages: Array.isArray(items) ? items.length : 0,
      nTools: Array.isArray(body.tools) ? body.tools.length : 0,
    };
  },

  view(body = {}) {
    const tools = (body.tools || []).map(toolView);

    if (isResponses(body)) {
      const system = body.instructions
        ? [{ label: "instructions", text: String(body.instructions), cache: false }]
        : [];
      const input = Array.isArray(body.input) ? body.input : body.input != null ? [body.input] : [];
      const messages = input.map((item, i) => {
        if (typeof item === "string") return { label: `input[${i}]`, role: "user", type: "message", text: item, cache: false };
        if (item.type === "function_call") {
          return {
            label: `input[${i}].function_call`, role: "assistant", type: "tool_use",
            name: item.name, callId: item.call_id || item.id,
            text: prettyArgs(item.arguments), cache: false,
          };
        }
        if (item.type === "function_call_output") {
          return {
            label: `input[${i}].function_call_output`, role: "tool", type: "tool_result",
            callId: item.call_id, isError: false,
            text: typeof item.output === "string" ? item.output : JSON.stringify(item.output, null, 2),
            cache: false,
          };
        }
        if (item.type === "reasoning") {
          const summaryText = Array.isArray(item.summary)
            ? item.summary.map((s) => s.text ?? "").join("")
            : flatten(item.content);
          return {
            label: `input[${i}].reasoning`,
            role: "assistant",
            type: "reasoning",
            text: summaryText || JSON.stringify(item),
            cache: false,
          };
        }
        return {
          label: `input[${i}].${item.role || item.type || "item"}`,
          role: item.role || item.type || "",
          type: item.type || "message",
          text: flatten(item.content) || JSON.stringify(item),
          cache: false,
        };
      });
      return { system, messages, tools };
    }

    // Chat Completions
    const all = body.messages || [];
    const system = all
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => m.role === "system" || m.role === "developer")
      .map(({ m, i }) => ({ label: `system[${i}].${m.role}`, text: flatten(m.content), cache: false }));
    const messages = all
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => m.role !== "system" && m.role !== "developer")
      .flatMap(({ m, i }) => {
        // A tool result: pair it back to the assistant tool_call by id.
        if (m.role === "tool") {
          return [{
            label: `msg[${i}].tool`, role: "tool", type: "tool_result",
            callId: m.tool_call_id, isError: false, text: flatten(m.content), cache: false,
          }];
        }
        // An assistant turn may carry several tool calls; expand one block each.
        if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
          const out = [];
          const said = flatten(m.content);
          if (said) out.push({ label: `msg[${i}].${m.role}`, role: m.role, type: "message", text: said, cache: false });
          m.tool_calls.forEach((tc, ti) => {
            const f = tc.function || {};
            out.push({
              label: `msg[${i}].${m.role}.tool_call[${ti}]`, role: m.role, type: "tool_use",
              name: f.name, callId: tc.id, text: prettyArgs(f.arguments), cache: false,
            });
          });
          return out;
        }
        return [{ label: `msg[${i}].${m.role}`, role: m.role, type: "message", text: flatten(m.content), cache: false }];
      });
    return { system, messages, tools };
  },

  blocks(body = {}) {
    const v = this.view(body);
    return [
      ...v.system.map((s) => ({ kind: "system", label: s.label, text: s.text, cache: false })),
      ...v.messages.map((m) => ({ kind: "message", label: m.label, type: m.type, text: m.text, cache: false })),
      ...v.tools.map((t) => ({ kind: "tool", label: `tool:${t.name}`, text: t.description, cache: false })),
    ];
  },

  // ---- streamed/non-streamed response → normalized -----------------------

  reassemble(raw, { normalizeUsage = normUsage } = {}) {
    if (!raw) return null;
    const trimmed = raw.trimStart();
    if (trimmed.startsWith("{")) {
      try {
        return normalizeFinal(JSON.parse(trimmed), normalizeUsage);
      } catch {
        return { streamed: false, raw: trimmed };
      }
    }

    let model = null;
    let stop_reason = null;
    let usage = {};
    let text = "";
    let reasoningText = "";
    const toolCalls = {}; // index/id -> {name, args}

    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let ev;
      try {
        ev = JSON.parse(payload);
      } catch {
        continue;
      }

      // Responses API events
      if (typeof ev.type === "string" && ev.type.startsWith("response.")) {
        if (ev.type === "response.output_text.delta") text += ev.delta || "";
        else if (ev.type === "response.reasoning_summary_text.delta") reasoningText += ev.delta || "";
        else if (ev.type === "response.output_text.done") { /* text complete; deltas already accumulated */ }
        else if (ev.type === "response.output_item.added" && ev.item?.type === "function_call") {
          toolCalls[ev.output_index ?? ev.item.id ?? Object.keys(toolCalls).length] = { name: ev.item.name, args: "" };
        } else if (ev.type === "response.function_call_arguments.delta") {
          const k = ev.output_index ?? ev.item_id ?? Object.keys(toolCalls).pop();
          if (toolCalls[k]) toolCalls[k].args += ev.delta || "";
        } else if (ev.type === "response.completed" || ev.type === "response.done") {
          model = ev.response?.model ?? model;
          stop_reason = ev.response?.status ?? stop_reason;
          if (ev.response?.usage) usage = ev.response.usage;
        } else if (ev.type === "response.created") {
          model = ev.response?.model ?? model;
        }
        continue;
      }

      // Chat Completions chunks
      if (ev.choices) {
        model = ev.model ?? model;
        for (const ch of ev.choices) {
          if (ch.delta?.content) text += ch.delta.content;
          if (ch.finish_reason) stop_reason = ch.finish_reason;
          for (const tc of ch.delta?.tool_calls || []) {
            const k = tc.index ?? tc.id ?? 0;
            toolCalls[k] = toolCalls[k] || { name: "", args: "" };
            if (tc.function?.name) toolCalls[k].name = tc.function.name;
            if (tc.function?.arguments) toolCalls[k].args += tc.function.arguments;
          }
        }
      }
      if (ev.usage) usage = ev.usage;
    }

    const content = [];
    if (reasoningText) content.push({ type: "reasoning", text: reasoningText });
    if (text) content.push({ type: "text", text });
    for (const tc of Object.values(toolCalls)) {
      let input;
      try {
        input = tc.args ? JSON.parse(tc.args) : {};
      } catch {
        input = { _raw: tc.args };
      }
      content.push({ type: "tool_use", name: tc.name, input });
    }
    return { streamed: true, model, stop_reason, usage: normalizeUsage(usage), content };
  },

  estimateTokens(body = {}) {
    let s = String(body.instructions || "");
    const items = isResponses(body) ? body.input : body.messages;
    for (const it of items || []) s += typeof it === "string" ? it : flatten(it.content);
    for (const t of body.tools || []) {
      const f = t.function || t;
      s += (f.description || "") + JSON.stringify(f.parameters || {});
    }
    return estimateTokens(s);
  },

  cost(model, usage = {}) {
    const p = priceFor(model);
    const cached = usage.cache_read_input_tokens || 0;
    const input = Math.max(0, (usage.input_tokens || 0) - cached); // uncached portion
    const output = usage.output_tokens || 0;
    const usd = (input * p.input + cached * p.cached + output * p.output) / 1e6;
    const totalInput = usage.input_tokens || 0;
    return {
      input: usage.input_tokens || 0,
      output,
      cacheWrite: 0,
      cacheRead: cached,
      totalInput,
      cacheHitRate: totalInput ? cached / totalInput : 0,
      usd,
    };
  },
};

function normUsage(u = {}) {
  return {
    input_tokens: u.input_tokens ?? u.prompt_tokens ?? 0,
    output_tokens: u.output_tokens ?? u.completion_tokens ?? 0,
    cache_read_input_tokens: u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
    cache_creation_input_tokens: 0,
  };
}

function normalizeFinal(json, normalizeUsage = normUsage) {
  // Responses API non-streaming
  if (json.output || json.object === "response") {
    const content = [];
    for (const item of json.output || []) {
      if (item.type === "reasoning") {
        const summaryText = Array.isArray(item.summary)
          ? item.summary.map((s) => s.text ?? "").join("")
          : "";
        if (summaryText) content.push({ type: "reasoning", text: summaryText });
      } else if (item.type === "message") {
        for (const c of item.content || []) if (c.text || c.output_text) content.push({ type: "text", text: c.text ?? c.output_text });
      } else if (item.type === "function_call") {
        let input;
        try {
          input = item.arguments ? JSON.parse(item.arguments) : {};
        } catch {
          input = { _raw: item.arguments };
        }
        content.push({ type: "tool_use", name: item.name, input });
      }
    }
    return { streamed: false, model: json.model, stop_reason: json.status, usage: normalizeUsage(json.usage), content };
  }
  // Chat Completions non-streaming
  if (json.choices) {
    const msg = json.choices[0]?.message || {};
    const content = [];
    if (msg.content) content.push({ type: "text", text: msg.content });
    for (const tc of msg.tool_calls || []) {
      let input;
      try {
        input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        input = { _raw: tc.function?.arguments };
      }
      content.push({ type: "tool_use", name: tc.function?.name, input });
    }
    return { streamed: false, model: json.model, stop_reason: json.choices[0]?.finish_reason, usage: normalizeUsage(json.usage), content };
  }
  if (json.error) return { streamed: false, error: json.error, usage: {} };
  return { streamed: false, raw: JSON.stringify(json) };
}

// Approximate OpenAI pricing, USD per 1M tokens (input / cached input / output).
const PRICES = {
  "gpt-5": { input: 1.25, cached: 0.125, output: 10 },
  codex: { input: 1.25, cached: 0.125, output: 10 },
  "gpt-4o": { input: 2.5, cached: 1.25, output: 10 },
  "gpt-4.1": { input: 2.0, cached: 0.5, output: 8 },
  "o3": { input: 2.0, cached: 0.5, output: 8 },
  mini: { input: 0.4, cached: 0.1, output: 1.6 },
};
function priceFor(model = "") {
  const m = model.toLowerCase();
  if (m.includes("codex")) return PRICES.codex;
  if (m.includes("mini")) return PRICES.mini;
  if (m.includes("gpt-5")) return PRICES["gpt-5"];
  if (m.includes("4o")) return PRICES["gpt-4o"];
  if (m.includes("4.1")) return PRICES["gpt-4.1"];
  if (m.includes("o3")) return PRICES.o3;
  return PRICES["gpt-5"];
}
