# ccglass: Bedrock mode requests bypass the proxy

**Status**: Bug report + proposed fix
**Affected versions**: 0.3.1 (current); likely all versions since Bedrock provider was added
**Affected users**: anyone running Claude Code in Bedrock mode (`CLAUDE_CODE_USE_BEDROCK=1`) — including AWS Bedrock proper, AWS-fronted gateways, and Bedrock-compat enterprise gateways like some company's `company-azure-gateway`

## Summary

When inspecting Claude Code in Bedrock mode, `ccglass claude` (or `ccglass run --provider bedrock -- claude`) silently captures **zero** requests. The dashboard stays empty, but Claude Code still answers prompts — making it look like the proxy is healthy.

The root cause is a one-line mismatch in `src/providers.js` and a matching gap in the `--settings` injection path in `src/cli.js`.

## How to reproduce

Configure Claude Code in Bedrock mode by adding to `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_USE_BEDROCK": "1",
    "ANTHROPIC_BEDROCK_BASE_URL": "https://your-bedrock-or-gateway.example.com"
  }
}
```

Then run any of:

```bash
ccglass claude -p "hi"
ccglass run --provider bedrock -- claude -p "hi"
```

**Expected**: dashboard captures the request to the gateway.
**Actual**: claude answers `hi`, but `ls .ccglass/<session>/` is empty. The request went directly to the gateway, not through the proxy.

## Root cause

Claude Code in Bedrock mode reads its endpoint from `ANTHROPIC_BEDROCK_BASE_URL`, **not** `ANTHROPIC_BASE_URL`. The two paths in ccglass that point a child claude at the proxy both hardcode the wrong variable:

### Issue 1 — `src/providers.js:95-104`

```js
bedrock: {
  label: "AWS Bedrock (via Claude Code)",
  command: "claude",
  format: "anthropic",
  envVar: "ANTHROPIC_BASE_URL",   // ← wrong; Bedrock mode ignores this
  upstream: "auto",
  autoUpstream: true,
  mcp: true,
  ...
},
```

`autoUpstream` (cli.js:211) reads `process.env[provider.envVar]` to discover the user's real upstream — so for Bedrock users it reads `ANTHROPIC_BASE_URL`, which is empty, falls through to the "needs an upstream URL" error if `--upstream` isn't passed. Worse, when an upstream *is* passed, ccglass spawns claude with `ANTHROPIC_BASE_URL=http://127.0.0.1:<proxyPort>` — which Bedrock mode ignores entirely. Claude continues using whatever `ANTHROPIC_BEDROCK_BASE_URL` it found in settings.json or env, talking to the real gateway directly. The proxy listens on a port nobody calls.

### Issue 2 — `src/cli.js:266-270`

```js
if (claudeBased && opts.settingsOverride && !provider.noSettings) {
  if (settingsBaseUrl)
    process.stderr.write(`...settings.json sets ANTHROPIC_BASE_URL=...`);
  args = ["--settings", JSON.stringify({ env: { ANTHROPIC_BASE_URL: proxyUrl } }), ...args];
}
```

The defensive `--settings` injection (which exists exactly to outrank a `settings.json.env` value with `--settings` precedence) also hardcodes `ANTHROPIC_BASE_URL`. So even with the override on, Bedrock-mode users' `settings.json.env.ANTHROPIC_BEDROCK_BASE_URL` is never overridden, and the proxy is never hit.

### Issue 3 — `src/cli.js:176-189` (`settingsEnvBaseUrl`)

```js
const url = JSON.parse(fs.readFileSync(f, "utf8"))?.env?.ANTHROPIC_BASE_URL;
```

Same hardcoded key. The auto-detect "use the URL from settings.json as upstream" feature also misses Bedrock-mode users, because their gateway URL lives under `env.ANTHROPIC_BEDROCK_BASE_URL`.

## Why this is hard to notice

Three things conspire to hide the failure:

1. Claude Code keeps working — it talks to the real gateway, gets a real response, prints it to the user.
2. The dashboard opens cleanly and shows "no requests yet," which looks like an interactive session that hasn't sent anything.
3. The CLI banner says `ccglass watching Claude Code → https://...gateway...`, suggesting the proxy is wired up.

There's no exit code, no warning, no log line indicating "the proxy never received a request." Users assume the empty dashboard is normal and either give up or open an issue without a repro.

## Proposed fix

Two line changes in `src/providers.js` plus one structural change in `src/cli.js` to read the right env var dynamically.

### `src/providers.js` — fix the `bedrock` provider

```diff
   bedrock: {
     label: "AWS Bedrock (via Claude Code)",
     command: "claude",
     format: "anthropic",
-    envVar: "ANTHROPIC_BASE_URL",
+    envVar: "ANTHROPIC_BEDROCK_BASE_URL",
     upstream: "auto",
     autoUpstream: true,
     mcp: true,
     note: "Bedrock: set ANTHROPIC_BASE_URL to your Bedrock endpoint before running...",
+    note: "Bedrock: set ANTHROPIC_BEDROCK_BASE_URL to your Bedrock endpoint before running (e.g. https://bedrock-runtime.us-east-1.amazonaws.com). AWS credentials are forwarded as-is.",
   },
```

(Vertex AI may have the same issue with `ANTHROPIC_VERTEX_PROJECT_ID` / its endpoint var — worth checking, separate fix.)

### `src/cli.js` — make the `--settings` injection use `provider.envVar`

```diff
   // Command-line --settings outranks ~/.claude/settings.json and deep-merges
   if (claudeBased && opts.settingsOverride && !provider.noSettings) {
-    if (settingsBaseUrl)
-      process.stderr.write(`  ...settings.json sets ANTHROPIC_BASE_URL=${settingsBaseUrl}; overriding it...`);
-    args = ["--settings", JSON.stringify({ env: { ANTHROPIC_BASE_URL: proxyUrl } }), ...args];
+    if (settingsBaseUrl)
+      process.stderr.write(`  ...settings.json sets ${provider.envVar}=${settingsBaseUrl}; overriding it...`);
+    args = ["--settings", JSON.stringify({ env: { [provider.envVar]: proxyUrl } }), ...args];
   }
```

### `src/cli.js` — fix `settingsEnvBaseUrl()` to read the provider's env var

Currently the function takes no arguments and hardcodes `ANTHROPIC_BASE_URL`. Make it parameterized:

```diff
-function settingsEnvBaseUrl() {
+function settingsEnvBaseUrl(envVar) {
   const files = [
     path.resolve(".claude/settings.local.json"),
     path.resolve(".claude/settings.json"),
     path.join(os.homedir(), ".claude", "settings.json"),
   ];
   for (const f of files) {
     try {
-      const url = JSON.parse(fs.readFileSync(f, "utf8"))?.env?.ANTHROPIC_BASE_URL;
+      const url = JSON.parse(fs.readFileSync(f, "utf8"))?.env?.[envVar];
       if (url) return url;
     } catch {}
   }
   return null;
 }
```

And update the call site in `wrap()`:

```diff
-  const settingsBaseUrl = claudeBased ? settingsEnvBaseUrl() : null;
+  const settingsBaseUrl = claudeBased ? settingsEnvBaseUrl(provider.envVar) : null;
```

The conditional that compares against the literal default upstream also needs to be generalized — currently it only fires for vanilla Anthropic:

```diff
-  if (!opts.upstream && settingsBaseUrl && provider.upstream === "https://api.anthropic.com") {
+  if (!opts.upstream && settingsBaseUrl && (provider.upstream === "https://api.anthropic.com" || provider.autoUpstream)) {
     upstream = settingsBaseUrl;
     process.stderr.write(`  ● ccglass: upstream from Claude Code settings.json → ${upstream}\n`);
   }
```

This makes the auto-discover-upstream-from-settings.json behavior work for Bedrock and Vertex (both have `autoUpstream: true`).

## Proposed tests

Add to `test/providers.test.js`:

```js
test("bedrock provider keys off ANTHROPIC_BEDROCK_BASE_URL", () => {
  const p = resolveProvider("bedrock");
  assert.equal(p.envVar, "ANTHROPIC_BEDROCK_BASE_URL");
});
```

Add a new test (or extend `test/cli.test.js`) that asserts the `--settings` injection writes the provider-specific key, not a hardcoded one. This is the regression test that would have caught the original mistake.

## Verified workaround (until the fix lands)

Pass the override manually:

```bash
ccglass claude \
  --upstream https://your-gateway \
  --env-var ANTHROPIC_BEDROCK_BASE_URL \
  --proxy-port 47291 \
  --no-settings-override \
  --settings '{"env":{"ANTHROPIC_BEDROCK_BASE_URL":"http://127.0.0.1:47291"}}'
```

The `--proxy-port` is fixed only so we can embed the matching URL inside `--settings` ahead of time. With the proposed fix, this workaround collapses to plain `ccglass claude`.

## Related

- ccglass v0.3.1 changelog mentions opencode auto-upstream and proxy URL validation — same area of the code, suggests this would be a clean follow-up.
- The default `bedrock` provider's `note:` field still says "set `ANTHROPIC_BASE_URL`" — that's a docs bug too, fixed by the diff above.
- Same pattern likely affects `vertex` provider (also `autoUpstream: true`, `command: "claude"`); needs separate verification with a Vertex setup.

## Suggested PR title

`fix(bedrock): use ANTHROPIC_BEDROCK_BASE_URL so proxy actually intercepts traffic`

## Suggested PR description (short)

> When `CLAUDE_CODE_USE_BEDROCK=1`, Claude Code reads its endpoint from `ANTHROPIC_BEDROCK_BASE_URL`. ccglass was injecting `ANTHROPIC_BASE_URL` for the bedrock provider, so the spawned claude ignored the proxy and went directly to the upstream — the dashboard silently captured nothing.
>
> This makes the `--settings` injection and `settingsEnvBaseUrl()` lookup use `provider.envVar` instead of a hardcoded key, and corrects the bedrock provider's `envVar` to `ANTHROPIC_BEDROCK_BASE_URL`. Adds regression tests.
