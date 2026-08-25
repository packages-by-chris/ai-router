/**
 * JSON-serializable router config. This shape is the cross-language contract:
 * the Python SDK validates against the same schema and the conformance
 * fixtures in /conformance are data-driven from it.
 */

/** Known provider ids. "openai-compatible" covers any OpenAI-shaped base URL. */
export const PROVIDER_IDS = ["openai", "openai-compatible", "azure", "anthropic", "gemini"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface LimitRule {
  /** Requests per minute, enforced pre-flight. */
  rpm?: number;
  /** Tokens per minute, accounted post-hoc from provider usage reports. */
  tpm?: number;
}

export interface BudgetRule {
  /**
   * Max USD spend across the rolling window (requires `pricing` for the
   * route or model). Enforced pre-flight from recorded spend; actual cost
   * is recorded post-hoc from provider usage reports.
   */
  usd: number;
  /** Budget window length in ms. Default 60000 (one minute). */
  windowMs?: number;
}

export interface ModelRoute {
  /** Logical name requests refer to, e.g. "fast". Must be unique. */
  id: string;
  provider: ProviderId;
  /** Provider-side model name, e.g. "gpt-4o-mini". For azure: the deployment name. */
  model: string;
  /** Single key (convenience). */
  apiKey?: string;
  /** Key pool. Merged with `apiKey`; engine rotates on rate_limit/auth/permission. */
  apiKeys?: string[];
  /**
   * Required for "openai-compatible" and "azure" (resource root, e.g.
   * https://{resource}.openai.azure.com), overrides the default otherwise.
   */
  baseUrl?: string;
  /** Azure only: API version query parameter, e.g. "2024-10-21". */
  apiVersion?: string;
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
  budget?: BudgetRule;
  /**
   * Weight for strategy "weighted" (relative traffic share; default 1).
   * Ignored by other strategies.
   */
  weight?: number;
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
   * - "round-robin": each request rotates the starting point cyclically.
   * - "weighted": each request picks the starting point proportional to
   *   route `weight`, then falls back in chain order from there.
   * - "least-latency": routes are tried fastest-first, using a per-route
   *   exponential moving average of observed success latency (in-process).
   * Only meaningful when tail routes are interchangeable with the primary.
   */
  strategy?: "fallback" | "round-robin" | "weighted" | "least-latency";
}
