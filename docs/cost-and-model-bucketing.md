# Design: Cost & model-bucketing fixes for ccglass

**Status:** Approved design, pending implementation
**Target:** upstream `github.com/jianshuo/ccglass`
**Shape:** three independent commits, landed in order, each keeping `npm test` (`node --test`) green standalone.

---

## Problem

Three classes of wrong numbers in the dashboard / usage rollup:

1. **AWS Bedrock responses land in `unmeasured`.** Bedrock streams `application/vnd.amazon.eventstream` framing, which `reassembleResponse` (`src/parse.js`) can't parse — it only understands a JSON body or `data:` SSE lines. No `usage` is recovered, so the record is counted under `unmeasured` (`src/usage.js:47-48,75`).
2. **Bedrock / gateway-proxied requests bucket under `"unknown"` at the Sonnet tier.** The rollup reads the model id from the (often empty) request body instead of the reassembled response, so every such request keys to `"unknown"` and `priceFor` falls through to the Sonnet default (`src/tokens.js:36`).
3. **`cost.input` is inconsistent across adapters.** Anthropic returns the uncached input portion (`src/tokens.js:54`); OpenAI (`src/formats/openai.js:247`) and Reasonix (`src/formats/reasonix.js:51`) return gross `input_tokens` (already including cached). Separately, all Haiku generations share one price bucket, so Haiku 4/4.5 traffic is underbilled.

### Verified impact (from the doc author's on-disk capture set)
Before: rollup reported **$9.36**, everything under `unknown` (Sonnet pricing on Opus traffic).
After: **$51.70**, correctly broken down by model. The ~5.5× gap is silent underbill.

> These dollar figures come from the author's capture set, not from this repo's code, and are unverified here.

---

## Key finding: the eventstream is already lossy at capture

The proxy stores response bodies as a UTF-8 string:

```js
// src/proxy.js:64
raw: Buffer.concat(respChunks).toString("utf8"),
```

AWS eventstream framing — 4-byte big-endian length preludes and CRC32 checksums — is **binary**. `toString("utf8")` replaces those bytes with U+FFFD at capture time, so the frame boundaries are destroyed *before* anything is persisted. **A true binary eventstream parser is therefore impossible on stored captures.**

What survives the lossy decode: each Bedrock frame's payload is an ASCII JSON envelope `{"bytes":"<base64>"}`, where the base64 decodes to one Anthropic streaming event. ASCII is invariant under `toString("utf8")`; U+FFFD only clobbers the binary framing *between* envelopes. So the recovery strategy is to **scan the stored `raw` for those envelopes and replay them**, not to parse the wire format.

**Decision (chosen): envelope-scan only.** No proxy/storage change; works on already-captured data. Explicitly *not* changing the capture path to preserve raw bytes (see Non-scope).

---

## Data flow

```
proxy capture ──► store (raw: utf8 string) ──► adapter.reassemble(raw) ──► { model, usage } ──► adapter.cost(model, usage) ──► usage rollup
                                                      ▲                            ▲
                                            C1: add envelope-scan       C2: use resp.model, not request.body.model
                                                path for Bedrock
```

No cycles. Commits 1 and 2 touch adjacent points on the same line; Commit 3 is orthogonal (pricing tables + adapter return shape).

---

## Commit 1 — Recover Bedrock usage from event-stream captures

**Files:** `src/parse.js`, `test/parse.test.js`

### Refactor
Extract the `switch (ev.type)` block in `reassembleResponse` (`src/parse.js:61-79`) into a shared helper that folds one event into accumulating state:

```
applyEvent(state, ev)   // state = { blocks, usage, stop_reason, model, error }
```

The existing SSE loop (`parse.js:51-80`) calls `applyEvent` unchanged. This is the helper the original plan named.

### New path
In `reassembleResponse`, when `raw` has **no** `data:` lines but matches `/\{"bytes":"[A-Za-z0-9+/=]+"\}/`:
1. Scan all `{"bytes":"<b64>"}` envelopes in document order.
2. For each: `JSON.parse(Buffer.from(b64, "base64").toString("utf8"))` → an Anthropic event object.
3. Feed each through `applyEvent` with the same accumulating state.
4. Return the existing `{ streamed: true, model, stop_reason, usage, content, error }` shape.

Because the return shape is unchanged, **all downstream callers (usage / server / mcp) need zero changes** for this commit.

### Edge cases
- Malformed base64 / non-JSON payload → skip that envelope (mirror the existing `try/catch continue` in the SSE loop), don't abort the whole response.
- Mixed/partial captures with no recoverable envelope → fall through to the current return (record stays `unmeasured`); no regression.

### Tests (`test/parse.test.js`)
- **Synthesized fixture** built to AWS's documented format: base64-wrapped `message_start` / `content_block_start` / `content_block_delta` / `message_delta` events, with U+FFFD and stray high bytes interleaved to mimic the lossy framing. Assert reconstructed `model`, `usage.input_tokens`, `usage.output_tokens`, `stop_reason`, and concatenated text — mirroring the existing streamed-SSE test.
- Negative test: a `raw` with no envelopes and no `data:` lines returns the unparsed fallback (no throw).

### Manual acceptance check
Run the usage rollup against one real Bedrock capture and confirm those records no longer count under `unmeasured`. **This is the gate for the fragile assumption below — the synthesized unit test alone does not prove the strategy against real data.**

---

## Commit 2 — Bucket by reassembled-response model

**Files:** `src/usage.js`, `src/server.js`, `src/mcp.js`, `src/session-stats.js`, `test/usage.test.js`, `test/session-stats.test.js`

**Precedence everywhere:** `resp.model || request.body.model || "unknown"`.

The cost callsites all currently pass `rec.request?.body?.model`:

| Callsite | Current | Change |
|---|---|---|
| `src/usage.js:50` (`costFor`) | `adapter.cost(rec.request?.body?.model, usage)` | use reassembled `resp.model` with fallback |
| `src/usage.js:80` (byModel key) | `rec.request?.body?.model \|\| "unknown"` | use the model `costFor` resolved |
| `src/server.js:110` | `A.cost(body.model, usage)` | `A.cost(response?.model \|\| body.model, usage)` |
| `src/mcp.js:24` | `adapter.cost(rec.request?.body?.model, usage)` | `adapter.cost(resp?.model \|\| rec.request?.body?.model, usage)` |
| `src/session-stats.js:97` (`aggregateSessionStats`) | `A.cost(body.model, usage)` | `A.cost(parsed?.model \|\| body.model, usage)` — `parsed` already reassembled for usage |

`costFor` (`usage.js:43-51`) currently returns only the cost object, but the byModel bucket at line 80 needs the resolved model too. **Change `costFor` to return `{ cost, model }`** (model = `resp.model || rec.request?.body?.model || "unknown"`) and update the two consumers at lines 74-82.

**Pricing correctness:** Bedrock model ids (e.g. `anthropic.claude-opus-4-…-v1:0`) still substring-match `priceFor`'s `"opus"` / `"haiku"` checks, so tiers resolve correctly off the response model.

### Tests (`test/usage.test.js`)
- A record whose request body has no `model` but whose reassembled response carries `model: "claude-opus-4-…"` buckets under that model (not `"unknown"`) and prices at the Opus tier.
- A record with neither still buckets under `"unknown"` (no regression).

---

## Commit 3 — Haiku price tiers + consistent `cost.input`

**Files:** `src/tokens.js`, `src/formats/openai.js`, `src/formats/reasonix.js`, `src/usage.js` (comment), `test/tokens.test.js`, `test/formats.test.js`, `test/reasonix-format.test.js`

### Haiku tiers (chosen: three tiers)
Split the single `haiku` bucket (`src/tokens.js:26-37`) by id pattern in `priceFor`:

| Tier | Match | Rate (USD / 1M in,out) |
|---|---|---|
| Haiku 3 | `3-haiku` / `claude-3-haiku` | **from official pricing page** |
| Haiku 3.5 | `haiku` + `3-5`/`3.5` | current `$0.80 / $4.00` |
| Haiku 4.x | other `haiku` (4 / 4.5) | **from official pricing page** |

> The two **bolded** rates are the one deferred unknown — lifted from Anthropic's official pricing page at implementation time, never quoted from memory. Match order must check the 3.x patterns before the generic `haiku` fallthrough.

### `cost.input` consistency
Both adapters already compute the uncached `input` for the USD math but then return gross:

- `src/formats/openai.js:247` — returns `usage.input_tokens` (gross) → return the uncached `input` already computed at line 242.
- `src/formats/reasonix.js:51` — returns `totalInput` → return the uncached `input` already computed at line 46.

USD is unaffected (it already uses the uncached portion). Only the reported `cost.input` token count changes, bringing OpenAI/Reasonix in line with Anthropic.

### Required follow-on (read-before-write catch)
`src/usage.js:22-25` documents the gross-vs-uncached disagreement as **intentional** ("OpenAI returns the gross `input_tokens` … trust each adapter's `totalInput`"). After this commit all adapters return uncached `input`, so that comment is wrong and **must be updated**. `totalInput` stays gross in every adapter, so `addInto`'s cache-hit-rate math (`usage.js:32,37`) is untouched.

### Tests
- `test/tokens.test.js`: `priceFor` returns distinct rates for `claude-3-haiku-*`, a 3.5 id, and a 4.x id.
- `test/formats.test.js` / `test/reasonix-format.test.js`: `cost(...).input` equals `input_tokens - cache_read_input_tokens` (uncached), while `totalInput` stays gross and `usd` is unchanged.

---

## Non-scope (explicitly not building)
- Changing the proxy capture path to preserve raw bytes / store Bedrock bodies as base64.
- A full RFC-compliant binary eventstream parser.
- Backfilling or re-pricing already-stored captures.

---

## Fragile assumption (premise collapse)
**This design assumes the `{"bytes":…}` envelopes survive the UTF-8 round-trip intact.** They do in principle — ASCII is invariant under `toString("utf8")`, and U+FFFD substitution is maximal-subpart, so the decoder resyncs at the next byte and never consumes the ASCII `{` of an envelope. **If** a real Bedrock body interleaves non-ASCII inside an envelope, or splits base64 across a replacement char, the scan silently misses frames. That failure is caught by the Commit 1 **manual acceptance check** (rollup must show 0 `unmeasured` Bedrock records), not by the synthesized unit test.

## Rollback
Pure code; no data or schema migration. Any of the three commits reverts independently without touching stored captures.

## Risk / blast radius
~15 files across 3 commits (acknowledged >8). Per-commit footprint is small and additive; downstream callers are insulated by the unchanged `reassembleResponse` return shape (C1) and the existing `cost`/`totalInput` contract (C3).

---

### Doc provenance
This file began as an OCR-garbled plan; corrected 2026-05-29 against the live code. Notable correction: the original "Haiku 4/4.5 billed at older Haiku 3 rate (~25% under)" was imprecise — `src/tokens.js:29` prices all Haiku at `$0.80/$4.00`, which is the **Haiku 3.5** rate, so Haiku 4.5 (~$1/$5) is underbilled ~20%. Reflected in Commit 3.
