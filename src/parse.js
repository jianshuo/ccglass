// Parsing helpers: turn a streamed SSE response back into a final message,
// and extract readable text from request content blocks.

// Flatten any content block into a readable string (used for diff + export).
export function blockText(b) {
  if (b == null) return "";
  if (typeof b === "string") return b;
  switch (b.type) {
    case "text":
      return b.text || "";
    case "thinking":
      return b.thinking || "";
    case "tool_use":
      return `[tool_use ${b.name}] ${JSON.stringify(b.input ?? {})}`;
    case "tool_result":
      return `[tool_result] ${typeof b.content === "string" ? b.content : JSON.stringify(b.content)}`;
    case "image":
      return "[image]";
    default:
      return b.text || JSON.stringify(b);
  }
}

// Reconstruct the final assistant message from a raw text/event-stream body.
// Falls back to JSON.parse for non-streaming responses.
export function reassembleResponse(raw) {
  if (!raw) return null;
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(trimmed);
      return {
        streamed: false,
        model: json.model,
        stop_reason: json.stop_reason,
        usage: json.usage || {},
        content: json.content || [],
        error: json.type === "error" ? json.error : undefined,
      };
    } catch {
      return { streamed: false, raw: trimmed };
    }
  }

  const state = { blocks: [], usage: {}, stop_reason: null, model: null, error: undefined };

  // AWS Bedrock streams `application/vnd.amazon.eventstream`. Its binary frame
  // headers (length preludes, CRC32s) are destroyed when the proxy stores the
  // body as a UTF-8 string (src/proxy.js), but each frame's ASCII payload —
  // `{"bytes":"<base64>", ...}`, base64-decoding to one Anthropic event —
  // survives intact. When the body carries no `data:` SSE lines but does carry
  // such envelopes, recover the events from them. See
  // docs/cost-and-model-bucketing.md.
  if (!/^data:/m.test(raw) && /"bytes":"[A-Za-z0-9+/=]+"/.test(raw)) {
    for (const match of raw.matchAll(/"bytes":"([A-Za-z0-9+/=]+)"/g)) {
      let ev;
      try {
        ev = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
      } catch {
        continue;
      }
      applyEvent(state, ev);
    }
    return finalizeState(state);
  }

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
    applyEvent(state, ev);
  }

  return finalizeState(state);
}

// Fold one streaming event into the accumulating reassembly state. Shared by
// the Anthropic SSE path and the Bedrock event-stream envelope path.
function applyEvent(state, ev) {
  switch (ev.type) {
    case "message_start":
      state.model = ev.message?.model ?? state.model;
      state.usage = { ...state.usage, ...(ev.message?.usage || {}) };
      break;
    case "content_block_start":
      state.blocks[ev.index] = startBlock(ev.content_block);
      break;
    case "content_block_delta":
      applyDelta(state.blocks[ev.index], ev.delta);
      break;
    case "message_delta":
      if (ev.delta?.stop_reason) state.stop_reason = ev.delta.stop_reason;
      if (ev.usage) state.usage = { ...state.usage, ...ev.usage };
      break;
    case "error":
      state.error = ev.error;
      break;
  }
}

function finalizeState(state) {
  return {
    streamed: true,
    model: state.model,
    stop_reason: state.stop_reason,
    usage: state.usage,
    content: state.blocks.filter(Boolean).map(finalizeBlock),
    error: state.error,
  };
}

function startBlock(cb = {}) {
  if (cb.type === "tool_use") return { ...cb, _json: "" };
  if (cb.type === "thinking") return { type: "thinking", thinking: cb.thinking || "" };
  if (cb.type === "text") return { type: "text", text: cb.text || "" };
  return { ...cb };
}

function applyDelta(block, delta = {}) {
  if (!block) return;
  switch (delta.type) {
    case "text_delta":
      block.text = (block.text || "") + (delta.text || "");
      break;
    case "thinking_delta":
      block.thinking = (block.thinking || "") + (delta.thinking || "");
      break;
    case "input_json_delta":
      block._json = (block._json || "") + (delta.partial_json || "");
      break;
  }
}

function finalizeBlock(block) {
  if (block.type === "tool_use" && block._json !== undefined) {
    try {
      block.input = block._json ? JSON.parse(block._json) : {};
    } catch {
      block.input = { _raw: block._json };
    }
    delete block._json;
  }
  return block;
}
