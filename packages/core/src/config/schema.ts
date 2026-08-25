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
  /**
   * Max silence between stream chunks (ms). Fires pre-commit (enabling
   * fallback) and post-commit (surfaces to the caller as a "timeout"
   * ProviderError). Default: disabled.
   */
  streamIdleTimeoutMs?: number;
  limit?: LimitRule;
}

export interface RouterConfig {
  /**
   * Ordered fallback chain. A request for route id at index i tries routes
   * i, i+1, ... in order.
   */
  routes: ModelRoute[];
  /**
   * Route selection across the chain.
   * - "fallback" (default): strict order — chain[0] is primary until it fails.
   * - "round-robin": each request rotates the starting point of the chain
   *   cyclically. Only meaningful when tail routes are interchangeable
   *   replicas of the primary.
   */
  strategy?: "fallback" | "round-robin";
}
