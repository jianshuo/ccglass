import { test } from "node:test";
import assert from "node:assert/strict";
import { openai } from "../src/formats/openai.js";
import { anthropic } from "../src/formats/anthropic.js";
import { detectFormat, getAdapter } from "../src/formats/index.js";

test("detectFormat: by recorded format, url, and body shape", () => {
  assert.equal(detectFormat({ format: "openai" }), "openai");
  assert.equal(detectFormat({ request: { url: "/v1/responses" } }), "openai");
  assert.equal(detectFormat({ request: { url: "/v1/chat/completions" } }), "openai");
  assert.equal(detectFormat({ request: { body: { instructions: "x", input: [] } } }), "openai");
  assert.equal(detectFormat({ request: { url: "/v1/messages", body: { system: [] } } }), "anthropic");
});

test("openai.view extracts instructions/input/tools (Responses API)", () => {
  const body = {
    model: "gpt-5-codex",
    instructions: "You are Codex.",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] },
    ],
    tools: [{ type: "function", name: "shell", description: "run shell", parameters: { type: "object" } }],
  };
  const v = openai.view(body);
  assert.equal(v.system[0].text, "You are Codex.");
  assert.match(v.messages[0].text, /list files/);
  assert.equal(v.tools[0].name, "shell");
});

test("anthropic.view surfaces tool name, call id, and error on history blocks", () => {
  const body = {
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_42", name: "Bash", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_42", is_error: true, content: "boom" }] },
    ],
  };
  const v = anthropic.view(body);
  const use = v.messages.find((m) => m.type === "tool_use");
  const res = v.messages.find((m) => m.type === "tool_result");
  assert.equal(use.name, "Bash");
  assert.equal(use.callId, "toolu_42");
  assert.match(use.text, /"command": "ls"/);
  assert.equal(res.callId, "toolu_42"); // pairs back to the tool_use
  assert.equal(res.isError, true);
  assert.equal(res.text, "boom");
});

test("openai.view surfaces tool calls (Chat Completions + Responses)", () => {
  const chat = openai.view({
    messages: [
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", function: { name: "get_weather", arguments: '{"city":"SF"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "72F" },
    ],
  });
  const cUse = chat.messages.find((m) => m.type === "tool_use");
  const cRes = chat.messages.find((m) => m.type === "tool_result");
  assert.equal(cUse.name, "get_weather");
  assert.equal(cUse.callId, "call_1");
  assert.equal(cRes.callId, "call_1");

  const resp = openai.view({
    input: [
      { type: "function_call", call_id: "fc_1", name: "shell", arguments: '{"cmd":"ls"}' },
      { type: "function_call_output", call_id: "fc_1", output: "a\nb" },
    ],
  });
  const rUse = resp.messages.find((m) => m.type === "tool_use");
  assert.equal(rUse.name, "shell");
  assert.equal(rUse.callId, "fc_1");
  assert.equal(resp.messages.find((m) => m.type === "tool_result").callId, "fc_1");
});

test("openai.reassemble rebuilds Responses API stream + usage", () => {
  const sse = [
    `data: {"type":"response.created","response":{"model":"gpt-5-codex"}}`,
    `data: {"type":"response.output_text.delta","delta":"Hello "}`,
    `data: {"type":"response.output_text.delta","delta":"world"}`,
    `data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":100,"output_tokens":20,"input_tokens_details":{"cached_tokens":80}}}}`,
  ].join("\n");
  const r = openai.reassemble(sse);
  assert.equal(r.content[0].text, "Hello world");
  assert.equal(r.usage.input_tokens, 100);
  assert.equal(r.usage.cache_read_input_tokens, 80);
  assert.equal(r.stop_reason, "completed");
});

test("openai.reassemble rebuilds Chat Completions stream", () => {
  const sse = [
    `data: {"model":"gpt-4o","choices":[{"delta":{"content":"hi"}}]}`,
    `data: {"choices":[{"delta":{"content":" there"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3}}`,
    `data: [DONE]`,
  ].join("\n");
  const r = openai.reassemble(sse);
  assert.equal(r.content[0].text, "hi there");
  assert.equal(r.usage.input_tokens, 10);
  assert.equal(r.usage.output_tokens, 3);
});

test("openai.cost subtracts cached tokens from billed input", () => {
  const c = openai.cost("gpt-5-codex", { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 800 });
  assert.equal(c.cacheRead, 800);
  assert.equal(c.input, 200); // uncached portion (1000 - 800), matching Anthropic's `input`
  assert.equal(c.totalInput, 1000); // gross stays for cache-hit math
  assert.ok(Math.abs(c.cacheHitRate - 0.8) < 1e-9);
  assert.ok(c.usd > 0);
});

test("getAdapter falls back to anthropic", () => {
  assert.equal(getAdapter("nope"), anthropic);
});

test("openai.view handles reasoning input items (Responses API)", () => {
  const body = {
    input: [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "I need to list files." }],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] },
    ],
  };
  const v = openai.view(body);
  const reasoning = v.messages.find((m) => m.type === "reasoning");
  assert.ok(reasoning, "reasoning block should be present");
  assert.match(reasoning.text, /I need to list files/);
  assert.equal(reasoning.label, "input[0].reasoning");
  assert.equal(reasoning.role, "assistant");
});

test("openai.reassemble handles reasoning_summary_text.delta and output_text.done events", () => {
  const sse = [
    `data: {"type":"response.created","response":{"model":"gpt-5-codex"}}`,
    `data: {"type":"response.reasoning_summary_text.delta","delta":"Thinking "}`,
    `data: {"type":"response.reasoning_summary_text.delta","delta":"step by step."}`,
    `data: {"type":"response.output_text.delta","delta":"Hello"}`,
    `data: {"type":"response.output_text.done","output_index":0}`,
    `data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":50,"output_tokens":10}}}`,
  ].join("\n");
  const r = openai.reassemble(sse);
  const reasoning = r.content.find((c) => c.type === "reasoning");
  assert.ok(reasoning, "reasoning block should be present");
  assert.match(reasoning.text, /Thinking step by step/);
  assert.equal(r.content.find((c) => c.type === "text")?.text, "Hello");
  assert.equal(r.usage.output_tokens, 10);
});

test("openai.reassemble handles reasoning blocks in non-streaming Responses API response", () => {
  const json = JSON.stringify({
    object: "response",
    model: "gpt-5-codex",
    status: "completed",
    output: [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "Let me think." }],
      },
      {
        type: "message",
        content: [{ type: "output_text", text: "Done." }],
      },
    ],
    usage: { input_tokens: 30, output_tokens: 5 },
  });
  const r = openai.reassemble(json);
  const reasoning = r.content.find((c) => c.type === "reasoning");
  assert.ok(reasoning, "reasoning block should be present");
  assert.match(reasoning.text, /Let me think/);
  assert.equal(r.content.find((c) => c.type === "text")?.text, "Done.");
});
