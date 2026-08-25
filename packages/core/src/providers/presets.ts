/**
 * Provider presets: the "100+ providers" mechanism.
 *
 * Most LLM vendors today serve an OpenAI-compatible chat-completions API —
 * they differ only in base URL and auth header. A preset is DATA, not code:
 * `provider: "groq"` in a route expands to the right adapter + baseUrl at
 * routing time, so a new provider costs one table entry instead of an
 * adapter. Native adapters remain reserved for protocol outliers
 * (anthropic, gemini, azure) and third-party registrations
 * (`registerAdapter`).
 */

/** Auth style for a preset endpoint. */
export type PresetAuth =
  /** `Authorization: Bearer <key>` (the OpenAI-compatible default). */
  | "bearer"
  /** Key sent in a named header instead of Authorization. */
  | { header: string }
  /** No auth required (local runtimes). The route may omit apiKey/apiKeys. */
  | "none";

export interface ProviderPreset {
  /**
   * Wire family serving this provider. Must be a built-in adapter id
   * ("openai-compatible" for virtually all presets).
   */
  adapter: string;
  baseUrl: string;
  auth?: PresetAuth;
  /** Static headers merged into every request (after auth headers). */
  headers?: Record<string, string>;
}

/**
 * Built-in preset catalog. Endpoints are the vendors' published
 * OpenAI-compatible URLs; keep additions boring and verifiable.
 */
export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  groq: {
    adapter: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
  },
  deepseek: {
    adapter: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
  },
  mistral: {
    adapter: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
  },
  openrouter: {
    adapter: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  together: {
    adapter: "openai-compatible",
    baseUrl: "https://api.together.xyz/v1",
  },
  fireworks: {
    adapter: "openai-compatible",
    baseUrl: "https://api.fireworks.ai/inference/v1",
  },
  perplexity: {
    adapter: "openai-compatible",
    baseUrl: "https://api.perplexity.ai",
  },
  xai: {
    adapter: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
  },
  cerebras: {
    adapter: "openai-compatible",
    baseUrl: "https://api.cerebras.ai/v1",
  },
  sambanova: {
    adapter: "openai-compatible",
    baseUrl: "https://api.sambanova.ai/v1",
  },
  cohere: {
    // Cohere's OpenAI-compatibility endpoint.
    adapter: "openai-compatible",
    baseUrl: "https://api.cohere.ai/compatibility/v1",
  },
  deepinfra: {
    adapter: "openai-compatible",
    baseUrl: "https://api.deepinfra.com/v1/openai",
  },
  nvidia: {
    adapter: "openai-compatible",
    baseUrl: "https://integrate.api.nvidia.com/v1",
  },
  "github-models": {
    adapter: "openai-compatible",
    baseUrl: "https://models.github.ai/inference",
  },
  hyperbolic: {
    adapter: "openai-compatible",
    baseUrl: "https://api.hyperbolic.xyz/v1",
  },
  novita: {
    adapter: "openai-compatible",
    baseUrl: "https://api.novita.ai/v3/openai",
  },
  nebius: {
    adapter: "openai-compatible",
    baseUrl: "https://api.studio.nebius.com/v1",
  },
  lambda: {
    adapter: "openai-compatible",
    baseUrl: "https://api.lambda.ai/v1",
  },

  // Local runtimes: no key needed.
  ollama: {
    adapter: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    auth: "none",
  },
  lmstudio: {
    adapter: "openai-compatible",
    baseUrl: "http://localhost:1234/v1",
    auth: "none",
  },
  vllm: {
    // vLLM hosts are deployment-specific; users typically override baseUrl,
    // but the default matches `vllm serve` on its standard port.
    adapter: "openai-compatible",
    baseUrl: "http://localhost:8000/v1",
    auth: "none",
  },
};

export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS[id];
}
