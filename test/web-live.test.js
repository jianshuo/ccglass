import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = { setProperty() {} };
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.innerHTML = "";
    this.textContent = "";
    this.hidden = false;
    this.open = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
  }

  append(...nodes) {
    this.children.push(...nodes.filter(Boolean));
  }

  appendChild(node) {
    this.children.push(node);
    return node;
  }

  addEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { left: 0, top: 0, bottom: 0, width: 0, height: 0 }; }
}

function textOf(node) {
  return [
    node.innerHTML,
    node.textContent,
    ...node.children.map(textOf),
  ].join("\n");
}

function loadApp() {
  const elements = new Map();
  const liveBody = new FakeElement();
  const livePane = new FakeElement();
  const document = {
    body: new FakeElement("body"),
    createElement: (tag) => new FakeElement(tag),
    addEventListener() {},
    querySelector(selector) {
      if (selector === "#detail .live-pane .live-body") return liveBody;
      if (selector === "#detail .live-pane") return livePane;
      if (!elements.has(selector)) elements.set(selector, new FakeElement());
      return elements.get(selector);
    },
  };
  const context = vm.createContext({
    document,
    window: { innerWidth: 1200, innerHeight: 800 },
    setTimeout,
    clearTimeout,
  });
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8")
    .replace(/\nloadSessions\(\)\.then\(connectStream\);\s*$/, "\n");
  vm.runInContext(source, context);
  return { context, liveBody };
}

test("Codex live stream omits request-side prompt/context", () => {
  const { context, liveBody } = loadApp();
  context.liveAppendEntry({
    seq: 1,
    model: "gpt-5-codex",
    response: { status: 200 },
    parsed: {
      view: {
        system: [{ label: "instructions", text: "private Codex instructions" }],
        messages: [{ role: "user", type: "message", text: "current Codex request prompt" }],
        tools: [{ name: "shell", description: "run commands" }],
      },
      response: {
        model: "gpt-5-codex",
        content: [{ type: "text", text: "visible Codex answer" }],
      },
    },
  });

  const html = textOf(liveBody);
  assert.match(html, /visible Codex answer/);
  assert.doesNotMatch(html, /current Codex request prompt/);
  assert.doesNotMatch(html, /private Codex instructions/);
  assert.doesNotMatch(html, /shell/);
});

test("Codex detected by client signature hides request side even on a plain model", () => {
  // Codex CLI can run a non-"codex" model (e.g. gpt-5). It's identified by its
  // codex_cli_rs user-agent, not the /v1/responses URL — that's what tells it
  // apart from a generic OpenAI Responses client.
  const { context, liveBody } = loadApp();
  context.liveAppendEntry({
    seq: 1,
    format: "openai",
    model: "gpt-5",
    request: {
      url: "/v1/responses",
      headers: { "user-agent": "codex_cli_rs/0.20.0" },
      body: { model: "gpt-5" },
    },
    response: { status: 200 },
    parsed: {
      format: "openai",
      view: {
        system: [{ label: "instructions", text: "private Codex instructions" }],
        messages: [{ role: "user", type: "message", text: "current Codex request prompt" }],
        tools: [{ name: "shell", description: "run commands" }],
      },
      response: {
        model: "gpt-5",
        content: [{ type: "text", text: "visible Codex answer" }],
      },
    },
  });

  const html = textOf(liveBody);
  assert.match(html, /visible Codex answer/);
  assert.doesNotMatch(html, /current Codex request prompt/);
  assert.doesNotMatch(html, /private Codex instructions/);
  assert.doesNotMatch(html, /shell/);
});

test("generic OpenAI Responses traffic keeps its request side visible", () => {
  // Regression: previously any openai-format /v1/responses call was treated as
  // Codex and had its prompt/tools/inputs hidden. A non-Codex Responses client
  // must show the full request.
  const { context, liveBody } = loadApp();
  context.liveAppendEntry({
    seq: 1,
    format: "openai",
    model: "gpt-5",
    request: {
      url: "/v1/responses",
      headers: { "user-agent": "openai-python/1.30.0" },
      body: { model: "gpt-5" },
    },
    response: { status: 200 },
    parsed: {
      format: "openai",
      view: {
        system: [{ label: "instructions", text: "ordinary system instructions" }],
        messages: [{ role: "user", type: "message", text: "ordinary request prompt" }],
        tools: [{ name: "lookup_widget", description: "find a widget" }],
      },
      response: {
        model: "gpt-5",
        content: [{ type: "text", text: "ordinary answer" }],
      },
    },
  });

  const html = textOf(liveBody);
  assert.match(html, /ordinary answer/);
  assert.match(html, /ordinary request prompt/);
  assert.match(html, /ordinary system instructions/);
  assert.match(html, /lookup_widget/);
});

test("failed Codex turn stays visible as an error row", () => {
  // Regression: a Codex request that errors before producing content (e.g. 401)
  // had its request side suppressed AND no response content, leaving zero steps
  // — the turn vanished. It must still render a terminal error row.
  const { context, liveBody } = loadApp();
  context.liveAppendEntry({
    seq: 1,
    model: "gpt-5-codex",
    request: {
      url: "/v1/responses",
      headers: { "user-agent": "codex_cli_rs/0.20.0" },
      body: { model: "gpt-5-codex" },
    },
    response: { status: 401 },
    parsed: {
      view: {
        system: [{ label: "instructions", text: "private Codex instructions" }],
        messages: [{ role: "user", type: "message", text: "current Codex request prompt" }],
        tools: [{ name: "shell", description: "run commands" }],
      },
      response: { error: { message: "invalid api key", type: "authentication_error" } },
    },
  });

  const html = textOf(liveBody);
  assert.match(html, /error 401/);
  assert.match(html, /invalid api key/);
  // request side still suppressed for Codex
  assert.doesNotMatch(html, /current Codex request prompt/);
  assert.doesNotMatch(html, /private Codex instructions/);
});

test("Codex live keeps tool_result output while hiding prompt context", () => {
  // Turn 1's response makes a function call (tool row, pending). Turn 2's request
  // carries the function_call_output (tool_result) plus fresh prompt/system. The
  // output must merge into the pending row even though Codex context is hidden.
  const { context, liveBody } = loadApp();
  context.liveAppendEntry({
    id: "sess/1", seq: 1, model: "gpt-5-codex",
    request: { url: "/v1/responses", headers: { "user-agent": "codex_cli_rs/0.20.0" }, body: { model: "gpt-5-codex" } },
    response: { status: 200 },
    parsed: {
      view: { system: [], messages: [], tools: [] },
      response: { model: "gpt-5-codex", content: [{ type: "tool_use", name: "shell", id: "call_1", input: { command: "ls" } }] },
    },
  });
  context.liveAppendEntry({
    id: "sess/2", seq: 2, model: "gpt-5-codex",
    request: { url: "/v1/responses", headers: { "user-agent": "codex_cli_rs/0.20.0" }, body: { model: "gpt-5-codex" } },
    response: { status: 200 },
    parsed: {
      view: {
        system: [{ label: "instructions", text: "secret instructions" }],
        messages: [
          { role: "user", type: "message", text: "secret new prompt" },
          { type: "tool_result", callId: "call_1", text: "file-a file-b" },
        ],
        tools: [],
      },
      response: { model: "gpt-5-codex", content: [{ type: "text", text: "done listing" }] },
    },
  });

  const html = textOf(liveBody);
  assert.match(html, /file-a file-b/);        // tool OUTPUT visible (merged)
  assert.doesNotMatch(html, /secret new prompt/);  // request prompt hidden
  assert.doesNotMatch(html, /secret instructions/); // system hidden
});

test("two Codex turns failing with the same error both stay visible", () => {
  // Each failed turn's only step is the error row; if they shared a dedup key,
  // the second would be hidden and its turn would vanish.
  const { context, liveBody } = loadApp();
  const failed = (seq) => ({
    id: "sess/" + seq,
    seq,
    model: "gpt-5-codex",
    request: { url: "/v1/responses", headers: { "user-agent": "codex_cli_rs/0.20.0" }, body: { model: "gpt-5-codex" } },
    response: { status: 401 },
    parsed: {
      view: { system: [{ label: "instructions", text: "x" }], messages: [{ role: "user", type: "message", text: "q" }], tools: [] },
      response: { error: { message: "invalid api key", type: "authentication_error" } },
    },
  });
  context.liveAppendEntry(failed(1));
  context.liveAppendEntry(failed(2));

  const html = textOf(liveBody);
  assert.equal((html.match(/invalid api key/g) || []).length, 2);
});

test("Summary by-session shows the name column; by-timestamp omits it", () => {
  const { context } = loadApp();
  const rows = [{ session: "2026-06-14T20-37-34-832", name: "usage-session-name", requests: 6, input: 12, output: 10955, cacheHitRate: 0.83, usd: 1.894 }];

  const bySession = context.bySessionHtml(rows);
  assert.match(bySession, /<th>name<\/th>/);
  assert.match(bySession, /usage-session-name/);

  const byTimestamp = context.bySessionHtml(rows, { showName: false });
  assert.doesNotMatch(byTimestamp, /<th>name<\/th>/);
  assert.doesNotMatch(byTimestamp, /usage-session-name/);
  // the raw timestamp id is still present in both
  assert.match(byTimestamp, /2026-06-14T20-37-34-832/);
});
