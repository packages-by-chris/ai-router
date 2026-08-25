export const STRATEGIES = [
  { value: "", label: "fallback · config order" },
  { value: "round-robin", label: "round-robin" },
  { value: "weighted", label: "weighted" },
  { value: "least-latency", label: "least-latency · observed" },
  { value: "cheapest", label: "cheapest · needs pricing" },
  { value: "balanced", label: "balanced · cost/speed/health" },
  { value: "quality-first", label: "quality-first · needs outcomes" },
] as const;

/** Capability checkboxes offered in the route editor. */
export const CAPABILITY_FLAGS = [
  "tools",
  "vision",
  "structuredOutput",
  "streaming",
  "reasoning",
  "embeddings",
] as const;

export type CapabilityFlag = (typeof CAPABILITY_FLAGS)[number];

export const PROVIDERS = [
  "openai",
  "azure",
  "anthropic",
  "gemini",
  "openai-compatible",
  // preset catalog picks — full list in @ai-router/core PROVIDER_PRESETS
  "groq",
  "deepseek",
  "openrouter",
  "mistral",
  "together",
  "xai",
  "perplexity",
  "ollama", // keyless local runtime
];

/** Presets that need no API key at all. */
export const KEYLESS_PROVIDERS = new Set(["ollama", "lmstudio", "vllm"]);

export const OUTCOME_LABEL: Record<string, string> = {
  ok: "served",
  error: "failed",
  retry: "retrying",
  skipped_rate_limit: "rate-limited",
  skipped_budget: "over budget",
  circuit_open: "circuit open",
  unsupported: "unsupported",
  capability_mismatch: "capability mismatch",
};
