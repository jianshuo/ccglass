import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateSessionStats,
  latencyMs,
  requestTiming,
  sessionModels,
  recordModel,
} from "../src/session-stats.js";

test("latencyMs uses startedAt when present, else ts", () => {
  assert.equal(latencyMs({ ts: 100, startedAt: 150, response: { finishedAt: 400 } }), 250);
  assert.equal(latencyMs({ ts: 100, response: { finishedAt: 500 } }), 400);
  assert.equal(latencyMs({ ts: 100, response: null }), null);
});

test("requestTiming computes TTFT and token throughput", () => {
  const t = requestTiming(
    {
      ts: 1000,
      startedAt: 1100,
      response: { firstByteAt: 1600, finishedAt: 2600 },
    },
    { input_tokens: 500, output_tokens: 100 },
  );
  assert.equal(t.ttftMs, 500);
  assert.equal(t.genMs, 1000);
  assert.equal(t.totalMs, 1500);
  assert.ok(Math.abs(t.inTps - 1000) < 1);
  assert.ok(Math.abs(t.outTps - 100) < 1);
});

test("sessionModels lists unique models from session records", () => {
  assert.deepEqual(
    sessionModels([
      { request: { body: { model: "gpt-4o" } } },
      { request: { body: { model: "gpt-4o-mini" } } },
      { request: { body: { model: "gpt-4o" } } },
      { request: { body: {} } },
    ]),
    ["gpt-4o", "gpt-4o-mini"],
  );
  assert.equal(recordModel({ request: { body: { model: "x" } } }), "x");
});

test("sessionModels includes models from transport and HTTP error responses", () => {
  assert.deepEqual(
    sessionModels([
      { request: { body: { model: "claude-sonnet" } }, response: { error: "ECONNRESET" } },
      {
        format: "openai",
        request: { body: { messages: [{ role: "user", content: "hi" }] } },
        response: {
          status: 429,
          raw: JSON.stringify({
            error: { message: "rate limited", type: "rate_limit" },
            model: "gpt-4o",
          }),
        },
      },
    ]),
    ["claude-sonnet", "gpt-4o"],
  );
  assert.equal(
    recordModel({
      format: "openai",
      request: { body: { messages: [] } },
      response: {
        status: 400,
        raw: JSON.stringify({ model: "gpt-4o-mini", error: { message: "bad" } }),
      },
    }),
    "gpt-4o-mini",
  );
});

test("aggregateSessionStats filters by model when requested", () => {
  const recA = {
    format: "openai",
    request: { body: { model: "gpt-4o" } },
    response: {
      raw: JSON.stringify({
        choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      }),
    },
  };
  const recB = {
    format: "openai",
    request: { body: { model: "gpt-4o-mini" } },
    response: {
      raw: JSON.stringify({
        choices: [{ message: { content: "yo" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 50, completion_tokens: 5 },
      }),
    },
  };
  const all = aggregateSessionStats([recA, recB]);
  assert.equal(all.totalInput, 150);
  const mini = aggregateSessionStats([recA, recB], { model: "gpt-4o-mini" });
  assert.equal(mini.model, "gpt-4o-mini");
  assert.equal(mini.total, 1);
  assert.equal(mini.totalInput, 50);
});

test("aggregateSessionStats sums tokens and cost across completed entries", () => {
  const stats = aggregateSessionStats([
    {
      format: "openai",
      request: { body: { model: "gpt-4o" } },
      response: {
        raw: JSON.stringify({
          choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80 } },
        }),
      },
    },
    {
      format: "openai",
      request: { body: { model: "gpt-4o" } },
      response: { error: "upstream down" },
    },
  ]);
  assert.equal(stats.completed, 1);
  assert.equal(stats.total, 2);
  assert.equal(stats.totalInput, 100);
  assert.equal(stats.totalOutput, 10);
  assert.ok(stats.cacheHitRate > 0.7);
  assert.ok(stats.totalUsd > 0);
});
