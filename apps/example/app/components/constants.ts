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
  // preset catalog picks — full list in @ai-router-sdk/core PROVIDER_PRESETS
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

/**
 * Static model suggestions per provider — shown before/when the live
 * POST /api/models fetch fails (no key yet, 401, offline).
 */
export const FALLBACK_MODELS: Record<string, string[]> = {
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "o4-mini"],
  anthropic: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
  groq: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  mistral: ["mistral-large-latest", "mistral-small-latest"],
  openrouter: [
    "openai/gpt-4o-mini",
    "anthropic/claude-3.5-sonnet",
    "meta-llama/llama-3.3-70b-instruct",
  ],
  together: [
    "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    "Qwen/Qwen2.5-72B-Instruct-Turbo",
  ],
  xai: ["grok-3-mini", "grok-2-latest"],
  perplexity: ["sonar", "sonar-pro"],
  ollama: ["llama3.2", "qwen2.5", "mistral"],
};

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
