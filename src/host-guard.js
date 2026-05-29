// Host-header allowlist for ccglass's local HTTP servers. The dashboard binds
// 127.0.0.1 so only the same machine can reach it, but a browser still treats
// a DNS-rebinding origin as same-origin — so a page the user visits while
// ccglass is running can read the captured LLM provider headers, prompts, and
// tool outputs unless we reject Host headers that don't match a known local
// name.
//
// CCGLASS_ALLOWED_HOSTS (comma-separated) extends the loopback default for
// operators serving the dashboard behind a reverse proxy or tunnel.

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const WILDCARD_BIND = new Set(["0.0.0.0", "::", "*"]);

// Return the host portion of a Host header (port stripped, brackets stripped,
// lowercased). Returns "" when the header is missing or malformed.
export function hostOnly(hostHeader) {
  if (typeof hostHeader !== "string" || hostHeader === "") return "";
  // Bracketed IPv6: "[::1]:1234" or "[::1]"
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    if (end < 0) return "";
    return hostHeader.slice(1, end).toLowerCase();
  }
  // Hostname or IPv4 with optional port
  const colon = hostHeader.indexOf(":");
  if (colon < 0) return hostHeader.toLowerCase();
  // Bare IPv6 without brackets is malformed in a Host header — reject.
  if (hostHeader.lastIndexOf(":") !== colon) return "";
  return hostHeader.slice(0, colon).toLowerCase();
}

// Build the set of host names that the guard will accept. Loopback names are
// always included. The configured bind host is added when concrete. The
// CCGLASS_ALLOWED_HOSTS env var extends the set with a comma-separated list.
export function buildAllowedHosts({ bindHost, allowedHostsEnv } = {}) {
  const set = new Set(LOOPBACK_NAMES);
  if (bindHost) {
    const h = String(bindHost).toLowerCase();
    if (!LOOPBACK_NAMES.has(h) && !WILDCARD_BIND.has(h)) set.add(h);
  }
  if (typeof allowedHostsEnv === "string") {
    for (const raw of allowedHostsEnv.split(",")) {
      const h = raw.trim().toLowerCase();
      if (h) set.add(h);
    }
  }
  return set;
}

// Pull the env allowlist value (string) from a process-env-shaped object.
export function resolveAllowedHostsFromEnv(env = process.env) {
  return env && typeof env.CCGLASS_ALLOWED_HOSTS === "string" ? env.CCGLASS_ALLOWED_HOSTS : "";
}

// Return a request handler that writes 403 + true when the Host header is not
// in the allowlist. Returns false on allow (caller should continue).
export function hostGuardMiddleware({ allowedHosts }) {
  return (req, res) => {
    const host = hostOnly(req.headers && req.headers.host);
    if (!host || !allowedHosts.has(host)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden host\n");
      return true;
    }
    return false;
  };
}
