// Pure classification helpers — importable in tests and inlined in app.js.

export function statusClass(status) {
  if (status == null) return "pending";
  if (status < 400) return "ok";
  if (status < 500) return "4xx";
  return "5xx";
}

export function groupRetries(entries, windowMs = 60_000) {
  const out = [];
  for (const e of entries) {
    const g = out[out.length - 1];
    const lastTs = g?.retries?.at(-1)?.ts ?? g?.ts;
    if (g && g.url === e.url && g.model === e.model && g.nMessages === e.nMessages && (e.ts - lastTs) < windowMs) {
      g.retries.push(e);
    } else {
      out.push({ ...e, retries: [] });
    }
  }
  return out;
}
