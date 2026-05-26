// Reasonix adapter: OpenAI Chat Completions wire format with DeepSeek usage
// fields (prompt_cache_hit_tokens / prompt_cache_miss_tokens) and pricing.

import { openai } from "./openai.js";

// USD per 1M tokens — mirrors DeepSeek-Reasonix DEEPSEEK_PRICING (stats.ts).
const PRICES = {
  "deepseek-v4-flash": { input: 0.14, cached: 0.0028, output: 0.28 },
  "deepseek-v4-pro": { input: 0.435, cached: 0.003625, output: 0.87 },
  "deepseek-chat": { input: 0.14, cached: 0.0028, output: 0.28 },
  "deepseek-reasoner": { input: 0.14, cached: 0.0028, output: 0.28 },
};

export function normUsageReasonix(u = {}) {
  const hit = u.prompt_cache_hit_tokens ?? 0;
  const miss = u.prompt_cache_miss_tokens ?? 0;
  const prompt = u.prompt_tokens ?? u.input_tokens ?? (hit + miss) ?? 0;
  const cached =
    hit ||
    u.cache_read_input_tokens ||
    u.input_tokens_details?.cached_tokens ||
    u.prompt_tokens_details?.cached_tokens ||
    0;
  return {
    input_tokens: prompt,
    output_tokens: u.completion_tokens ?? u.output_tokens ?? 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
  };
}

function priceForReasonix(model = "") {
  const m = model.toLowerCase();
  if (m.includes("v4-pro")) return PRICES["deepseek-v4-pro"];
  if (m.includes("reasoner")) return PRICES["deepseek-reasoner"];
  if (m.includes("v4-flash") || m.includes("deepseek-chat") || m.includes("deepseek")) {
    return PRICES["deepseek-v4-flash"];
  }
  return PRICES["deepseek-v4-flash"];
}

function costReasonix(model, usage = {}) {
  const u = normUsageReasonix(usage);
  const p = priceForReasonix(model);
  const cached = u.cache_read_input_tokens || 0;
  const input = Math.max(0, (u.input_tokens || 0) - cached);
  const output = u.output_tokens || 0;
  const usd = (input * p.input + cached * p.cached + output * p.output) / 1e6;
  const totalInput = u.input_tokens || 0;
  return {
    input: totalInput,
    output,
    cacheWrite: 0,
    cacheRead: cached,
    totalInput,
    cacheHitRate: totalInput ? cached / totalInput : 0,
    usd,
  };
}

export const reasonix = {
  ...openai,
  name: "reasonix",
  reassemble(raw, opts = {}) {
    return openai.reassemble(raw, { normalizeUsage: normUsageReasonix, ...opts });
  },
  cost: costReasonix,
};
