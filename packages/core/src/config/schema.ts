/**
 * JSON-serializable router config. This shape is the cross-language contract:
 * the Python SDK validates against the same schema and the conformance
 * fixtures in /conformance are data-driven from it.
 */

/** Known provider ids. "openai-compatible" covers any OpenAI-shaped base URL. */
export const PROVIDER_IDS = ["openai", "openai-compatible", "anthropic", "gemini"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface LimitRule {
  /** Requests per minute, enforced pre-flight. */
  rpm?: number;
  /** Tokens per minute, accounted post-hoc from provider usage reports. */
  tpm?: number;
}

export interface ModelRoute {
  /** Logical name requests refer to, e.g. "fast". Must be unique. */
  id: string;
  provider: ProviderId;
  /** Provider-side model name, e.g. "gpt-4o-mini". */
  model: string;
  /** Single key (convenience). */
  apiKey?: string;
  /** Key pool. Merged with `apiKey`; engine rotates on rate_limit/auth/permission. */
  apiKeys?: string[];
  /** Required for "openai-compatible", overrides the default for known providers. */
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Retries per route (same key or rotated). Default 2. */
  maxRetries?: number;
  /** Per-attempt HTTP timeout. Default 30000. */
  timeoutMs?: number;
  limit?: LimitRule;
}

export interface RouterConfig {
  /**
   * Ordered fallback chain. A request for route id at index i tries routes
   * i, i+1, ... in order.
   */
  routes: ModelRoute[];
}
