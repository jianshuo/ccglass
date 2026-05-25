# Content-Addressed Storage for ccglass Captures

**Date:** 2026-05-25
**Status:** Approved design, pending implementation plan

## Problem

Every LLM API call resends the entire conversation so far. ccglass stores each
call as a standalone full snapshot (`src/store.js` `Store.add` →
`fs.writeFileSync(this._file(seq), JSON.stringify(rec, null, 2))`). So within one
session:

- `0001.json` = messages `[1]`
- `0002.json` = messages `[1,2,3]`
- `0003.json` = messages `[1..5]`
- `NNNN.json` = the whole history again

The shared prefix — plus the large, identical `tools` and `system` blocks sent on
every call — is re-stored in every file. Storage grows as **O(n²)** in the number
of turns, making long agent sessions so large they become unusable.

## Goal

Stop storing the unchanged content repeatedly. Move to a **content-addressed**
("git-like") model where each unit of content is stored once and referenced by
hash, bringing storage down to **≈ O(n)**. The capture format, read API, and all
existing consumers must keep working.

## Non-Goals (YAGNI for v1)

- Per-content-block granularity (we split per whole message).
- A global cross-project blob store.
- Automatic background GC.
- Content-addressing the response (it is never repeated across requests).
- Compressing blobs (gzip can be layered on later as an orthogonal step).

## Design

### Granularity (decided)

Per **message**. Hash each element of the history array (`messages[]` for
Anthropic, `input[]` for OpenAI). Store the whole `tools` array as one blob and
the `system` value as one blob. History grows by appending whole messages, so
per-message addressing captures essentially all redundancy with the simplest
possible reconstruction (an ordered list of hashes).

### Blob store (decided: per-project-root)

Layout: `<root>/blobs/<ab>/<sha256>.json`, sharded by the first 2 hex chars of the
hash (git-style). One blob holds the exact JSON of one unit: one message object,
the whole `tools` array, or the `system` value. Content-addressed by sha256 of the
canonical serialization → write-once, immutable, automatic dedup. Blobs are shared
across all sessions under a single project-key root, so identical tool definitions
dedupe across sessions too. Keeps a project's data self-contained and portable.

### Manifest format (v2)

The v2 manifest replaces today's full `NNNN.json`:

```json
{
  "v": 2,
  "id": "<session>/0002", "session": "...", "seq": 2, "ts": 1234,
  "format": "anthropic",
  "request": {
    "headers": { "...": "small, inline, already redacted" },
    "meta": { "model": "...", "max_tokens": 1024 },
    "system": "sha256:abc…",
    "tools":  "sha256:def…",
    "messages": ["sha256:m1…", "sha256:m2…", "sha256:m3…"]
  },
  "response": { "...": "inline (unique per call, not repeated)" }
}
```

- `meta` = the request body minus `system`/`tools`/`messages`/`input`.
- `system` / `tools` blob refs are `null` when absent.
- `messages` is the ordered list of message-blob refs (uses `input[]` for OpenAI).
- The split is **lossless**: reconstructing concatenates `meta` + resolved
  `system`/`tools`/`messages` back into the exact original body.
- `response` stays inline because it is never repeated across requests;
  content-addressing it would add lookups for zero dedup benefit.

### New module: `src/blobs.js`

Single responsibility — blob storage. Pure-ish helpers plus blob IO:

- `writeBlob(root, value) → "sha256:…"` — serialize → sha256 → if
  `<root>/blobs/<ab>/<sha>.json` is absent, atomically write (temp file + `rename`)
  → return ref. If present, return ref directly (natural dedup).
- `readBlob(root, ref) → value` — parse ref, read file, `JSON.parse`.
- `packRecord(root, rec) → manifest` — split `system`/`tools`/`messages` into blobs,
  build the v2 manifest.
- `unpackRecord(root, manifest) → rec` — resolve blob refs, reassemble the exact
  original full record.

### Write path

`Store.add` / `Store.update` (`src/store.js`): instead of writing the full record,
call `packRecord` to write the blobs, then `writeFileSync` the v2 manifest. `update()`
(which fills in the response) rewrites only the manifest — blobs are already on disk
and the response is inline. The in-memory `this.entries` keeps full records, so the
dashboard's live push is unchanged.

### Read path (consumers unchanged)

The only change point is `readRecordFile` (`src/store.js`), the shared base of
`loadSession*` and `readEntryById*`:

```
read file → JSON.parse →
  if (rec.v === 2)  return unpackRecord(root, rec)   // reconstruct full rec
  else              return rec                         // legacy full record, as-is
```

`summarize`, `server.js`, `mcp.js`, `log-cli.js`, and `diff.js` are all unaffected —
they still receive a complete rec identical to today. `readRecordFile` (and its
callers `loadSession`, `loadSessionMulti`, `readEntryById`, `readEntryByIdMulti`)
gain a `root` argument so blob refs resolve against the correct root; the callers
already know the current root.

### Auto-migration (read-time repack)

In the legacy branch of `readRecordFile` (`rec.v !== 2`), after building the full
rec, also repack it in place:

- Call `packRecord(root, rec)`, write blobs, and overwrite `NNNN.json` with the v2
  manifest **atomically** (write `NNNN.json.tmp`, then `rename`).
- **Idempotent & safe:** already-v2 files are untouched; if the root is read-only
  (e.g. a legacy `./.ccglass` that is not writable), a `try/catch` swallows the
  error and still returns the reconstructed rec — migration failure never breaks a
  read.
- Multi-root: migrate only the file in the root where the record actually lives.
- Migration is lazy ("migrate on read"), so after upgrading, simply browsing old
  sessions shrinks them in place. A `ccglass repack [session]` command provides an
  explicit full-pass entry point (reusing the same pack logic) for one-shot
  slimming of existing data.

### Delete-time GC

New command `ccglass rm <session>`:

1. Delete the entire `<root>/<session>/` directory.
2. Scan all **remaining** manifests under that root and collect the set of sha refs
   still in use.
3. Delete blobs under `<root>/blobs/` not in that set.

A full scan at delete time — simple, reliable, no reference-counter maintenance.
This is mark-and-sweep, matching `git gc`. (No explicit session-delete command
exists today, so `ccglass rm` is the new home for "delete + reclaim".)

## Error Handling / Edge Cases

- **Missing blob:** `unpackRecord` backfills a placeholder object
  (`{ __missing_blob: "sha…" }`) instead of throwing, so one bad record does not
  break loading the whole session.
- **Corrupt manifest:** `readRecordFile` already `try/catch`es and returns null;
  this is preserved.
- **Concurrency:** blob writes are write-once + temp-file `rename`, inherently safe;
  a duplicate sha write is skipped.
- **Optional fields:** `system` may be a string or an array; `tools`/`system` may be
  absent → store the ref as `null` and omit on rebuild, guaranteeing an exact
  round-trip.

## Testing (`node --test`, matching existing style)

- `test/blobs.test.js`: `writeBlob` dedup (writing identical content twice produces
  one file and the same ref); `readBlob` round-trip; correct shard directory.
- `test/store.test.js` (extended): `pack → unpack` is **exactly equivalent** to the
  original rec across body shapes (Anthropic `system` array / OpenAI `input` / no
  `tools` / `system` as string) — losslessness is the core property; v2 files read
  via `loadSession`/`readEntryById` match the legacy full-format result.
- Migration: drop a legacy `NNNN.json`, read once → file becomes v2, blobs land on
  disk, returned rec unchanged; read again → idempotent.
- GC: two sessions share a blob; after `rm` of one, the shared blob remains and the
  blob unique to the deleted session is removed.
- **Dedup assertion:** construct N requests with growing prefixes; assert total blob
  count ≈ O(N), not O(N²) — guards the core purpose of this change.

## Affected Files

- `src/blobs.js` — new module.
- `src/store.js` — write path (`add`/`update`), read path (`readRecordFile` +
  thread `root` through `loadSession*` / `readEntryById*`), auto-migration.
- `src/cli.js` — new `rm` and `repack` subcommands.
- `test/blobs.test.js` — new.
- `test/store.test.js` — extended.
