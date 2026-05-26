// Format registry + detection. Each entry captured by ccglass carries a
// `format` (set from the active provider); detection is the fallback for
// generic `ccglass run` sessions or older logs.

import { anthropic } from "./anthropic.js";
import { openai } from "./openai.js";
import { reasonix } from "./reasonix.js";

export const FORMATS = { anthropic, openai, reasonix };

export function getAdapter(name) {
  return FORMATS[name] || anthropic;
}

export function detectFormat(rec) {
  if (rec?.format && FORMATS[rec.format]) return rec.format;
  const url = rec?.request?.url || "";
  const b = rec?.request?.body || {};
  if (/\/responses|\/chat\/completions/.test(url)) return "openai";
  if (b && (b.input !== undefined || b.instructions !== undefined)) return "openai";
  if (Array.isArray(b?.tools) && b.tools.some((t) => t?.type === "function" || t?.function)) return "openai";
  return "anthropic";
}
