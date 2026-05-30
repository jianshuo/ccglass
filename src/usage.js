// Token-usage rollup across captured sessions. Walks every record under the
// given roots once, reassembles each response via the per-format adapter, and
// folds the resulting usage/cost into totals + per-model + per-session
// breakdowns. Records without a parseable response.usage are counted under
// `unmeasured` so the caller can tell aggregated numbers are a lower bound.

import { listSessionsMulti, loadSessionMulti } from "./store.js";
import { getAdapter, detectFormat } from "./formats/index.js";

function blankBucket() {
  return {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalInput: 0,
    usd: 0,
  };
}

// Every adapter now reports `input` as the uncached portion and `cacheRead` as
// the cached portion, with `totalInput` the gross (uncached + cached). Sum
// `totalInput` for cache-hit math rather than recomputing it from input +
// cacheRead + cacheWrite, so the rollup stays correct no matter how each API
// reports its raw counts.
function addInto(bucket, cost) {
  bucket.requests += 1;
  bucket.input += cost.input || 0;
  bucket.output += cost.output || 0;
  bucket.cacheRead += cost.cacheRead || 0;
  bucket.cacheWrite += cost.cacheWrite || 0;
  bucket.totalInput += cost.totalInput || 0;
  bucket.usd += cost.usd || 0;
}

function deriveTotals(b) {
  const cacheHitRate = b.totalInput ? b.cacheRead / b.totalInput : 0;
  return { ...b, cacheHitRate };
}

// Reassemble one record's response and ask its adapter for cost. Returns null
// when the record has no parseable usage (in-flight, errored, or non-LLM).
// The model comes from the reassembled response (the source of truth) rather
// than the request body, which is empty for Bedrock/gateway-proxied traffic
// and would otherwise bucket every such request under "unknown".
function costFor(rec) {
  const adapter = getAdapter(detectFormat(rec));
  const resp = rec.response?.raw ? adapter.reassemble(rec.response.raw) : rec.response || {};
  const usage = resp?.usage;
  if (!usage || (!usage.input_tokens && !usage.output_tokens && !usage.prompt_tokens && !usage.completion_tokens)) {
    return null;
  }
  const model = resp?.model || rec.request?.body?.model || "unknown";
  return { cost: adapter.cost(model, usage), model };
}

export function summarizeUsage(roots) {
  const totals = blankBucket();
  const byModelMap = new Map();
  const bySession = [];
  let unmeasured = 0;
  let from = null;
  let to = null;

  for (const session of listSessionsMulti(roots)) {
    const recs = loadSessionMulti(roots, session);
    const sessionBucket = blankBucket();
    let sessionFrom = null;
    let sessionTo = null;

    for (const rec of recs) {
      if (rec.ts) {
        if (sessionFrom == null || rec.ts < sessionFrom) sessionFrom = rec.ts;
        if (sessionTo == null || rec.ts > sessionTo) sessionTo = rec.ts;
        if (from == null || rec.ts < from) from = rec.ts;
        if (to == null || rec.ts > to) to = rec.ts;
      }
      const res = costFor(rec);
      if (!res) { unmeasured += 1; continue; }
      const { cost, model } = res;

      addInto(totals, cost);
      addInto(sessionBucket, cost);

      if (!byModelMap.has(model)) byModelMap.set(model, blankBucket());
      addInto(byModelMap.get(model), cost);
    }

    bySession.push({
      session,
      entries: recs.length,
      from: sessionFrom ? new Date(sessionFrom).toISOString() : null,
      to: sessionTo ? new Date(sessionTo).toISOString() : null,
      ...deriveTotals(sessionBucket),
    });
  }

  const byModel = [...byModelMap.entries()]
    .map(([model, b]) => ({ model, ...deriveTotals(b) }))
    .sort((a, b) => b.usd - a.usd);

  return {
    sessionCount: bySession.length,
    requestCount: totals.requests,
    unmeasured,
    range: {
      from: from ? new Date(from).toISOString() : null,
      to: to ? new Date(to).toISOString() : null,
    },
    totals: deriveTotals(totals),
    byModel,
    bySession,
  };
}
