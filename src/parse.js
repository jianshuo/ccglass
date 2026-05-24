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

  const blocks = [];
  let usage = {};
  let stop_reason = null;
  let model = null;
  let error;

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
    switch (ev.type) {
      case "message_start":
        model = ev.message?.model ?? model;
        usage = { ...usage, ...(ev.message?.usage || {}) };
        break;
      case "content_block_start":
        blocks[ev.index] = startBlock(ev.content_block);
        break;
      case "content_block_delta":
        applyDelta(blocks[ev.index], ev.delta);
        break;
      case "message_delta":
        if (ev.delta?.stop_reason) stop_reason = ev.delta.stop_reason;
        if (ev.usage) usage = { ...usage, ...ev.usage };
        break;
      case "error":
        error = ev.error;
        break;
    }
  }

  return {
    streamed: true,
    model,
    stop_reason,
    usage,
    content: blocks.filter(Boolean).map(finalizeBlock),
    error,
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
