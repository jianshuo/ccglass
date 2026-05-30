// Aggregate token/cost/cache metrics for a session's captured records.

import { getAdapter, detectFormat } from "./formats/index.js";

export function latencyMs(rec) {
  const end = rec.response?.finishedAt;
  if (end == null) return null;
  const start = rec.startedAt ?? rec.ts;
  if (start == null) return null;
  return Math.max(0, end - start);
}

/** Timing breakdown for dashboard (TTFT + token throughput). */
export function requestTiming(rec, usage = {}) {
  const resp = rec.response;
  if (resp?.finishedAt == null) return null;
  const started = rec.startedAt ?? rec.ts;
  if (started == null) return null;

  const end = resp.finishedAt;
  const first = resp.firstByteAt ?? end;
  const totalMs = Math.max(0, end - started);
  const ttftMs = Math.max(0, first - started);
  const genMs = Math.max(0, end - first);

  const inTok = usage.input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  const ttftSec = ttftMs / 1000;
  const genSec = genMs / 1000;

  return {
    totalMs,
    ttftMs,
    genMs,
    inTps: inTok > 0 && ttftSec > 0 ? inTok / ttftSec : null,
    outTps: outTok > 0 && genSec > 0 ? outTok / genSec : null,
  };
}

/**
 * Model id for a record.
 *
 * Default (body-first) is the cheap label for the session *list* overview
 * (`store.js` maps it over every live entry): trust the request body's model and
 * only reassemble the response when the body has none.
 *
 * `preferResponse: true` resolves the reassembled *response* model first, the
 * same precedence `aggregateSessionStats` prices by (`parsed.model ||
 * body.model`). The per-session dropdown + filter use it so a gateway/Bedrock
 * record whose request body has no model — or a differing alias — is listed,
 * filtered, and charged under one consistent (priced) model id.
 */
export function recordModel(rec, { preferResponse = false } = {}) {
  const body = rec.request?.body;
  const bodyModel = body && typeof body === "object" && body.model ? body.model : null;
  if (!preferResponse && bodyModel) return bodyModel;

  const raw = rec.response?.raw;
  if (raw && typeof raw === "string") {
    try {
      const A = getAdapter(detectFormat(rec));
      const parsed = A.reassemble(raw);
      if (parsed?.model) return parsed.model;
    } catch {
      /* fall through */
    }

    try {
      const json = JSON.parse(raw.trimStart());
      if (json?.model) return json.model;
    } catch {
      /* not JSON */
    }
  }

  return bodyModel;
}

/** Unique model names used in a session, sorted. */
export function sessionModels(records) {
  const set = new Set();
  for (const rec of records) {
    const m = recordModel(rec, { preferResponse: true });
    if (m) set.add(m);
  }
  return [...set].sort();
}

export function aggregateSessionStats(records, options = {}) {
  const model = options.model;
  const scoped =
    model && model !== "all"
      ? records.filter((r) => recordModel(r, { preferResponse: true }) === model)
      : records;

  let totalInput = 0;
  let totalOutput = 0;
  let cacheRead = 0;
  let totalUsd = 0;
  let completed = 0;

  for (const rec of scoped) {
    const resp = rec.response;
    if (!resp || resp.error) continue;

    const fmt = detectFormat(rec);
    const A = getAdapter(fmt);
    const body = rec.request?.body || {};
    const parsed = resp.raw ? A.reassemble(resp.raw) : resp;
    const usage = parsed?.usage || {};
    // Prefer the reassembled response model; the request body carries no model
    // for Bedrock/gateway-proxied traffic, which would otherwise price at the
    // Sonnet default tier (matches costFor in usage.js).
    const model = parsed?.model || body.model;
    const c = A.cost(model, usage);

    totalInput += c.totalInput ?? c.input ?? 0;
    totalOutput += c.output ?? 0;
    cacheRead += c.cacheRead ?? 0;
    totalUsd += c.usd ?? 0;
    completed++;
  }

  return {
    model: model && model !== "all" ? model : "all",
    completed,
    total: scoped.length,
    totalInput,
    totalOutput,
    cacheHitRate: totalInput > 0 ? cacheRead / totalInput : 0,
    totalUsd,
  };
}
