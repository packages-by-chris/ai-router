/**
 * JSON-serializable router config. This shape is the cross-language contract:
 * the Python SDK validates against the same schema and the conformance
 * fixtures in /conformance are data-driven from it.
 */

import type { ModelCapabilities } from "../routing/capabilities.js";

/** Known provider ids. "openai-compatible" covers any OpenAI-shaped base URL. */
export const PROVIDER_IDS = [
  "openai",
  "openai-compatible",
  "azure",
  "anthropic",
  "gemini",
  "bedrock",
  "vertex",
] as const;
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
  /**
   * bedrock: AWS region (e.g. "us-east-1"). vertex: GCP region
   * (e.g. "us-central1"). Required for those providers.
   */
  region?: string;
  /** vertex only: GCP project id. Required for vertex. */
  project?: string;
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
  /**
   * Declared model capability profile. When present, the router eliminates
   * candidates that cannot serve a request (tools/vision/structured output/
   * context window/...) BEFORE execution. Omitted = route is always
   * eligible (unknown profile never filters).
   */
  capabilities?: ModelCapabilities;
}

export type RoutingStrategy =
  | "fallback"
  | "round-robin"
  | "weighted"
  | "least-latency"
  | "cheapest"
  | "balanced"
  | "quality-first";

export interface RouterConfig {
  /**
   * Ordered fallback chain. A request for route id at index i tries routes
   * i, i+1, ... in order.
   */
  routes: ModelRoute[];
  /**
   * Route selection across the chain. All strategies keep fallback order
   * AFTER the chosen start: they reorder/pick where traffic lands first,
   * then walk the remaining chain on failure.
   * - "fallback" (default): strict order — chain[0] is primary until it fails.
   * - "round-robin": each request rotates the starting point cyclically.
   * - "weighted": each request picks the starting point proportional to
   *   route `weight`, then falls back in chain order from there.
   * - "least-latency": routes are tried fastest-first, using a per-route
   *   exponential moving average of observed success latency (in-process).
   * - "cheapest": priced routes first, ordered by estimated per-request USD
   *   cost ascending (unpriced routes follow in config order). Requires
   *   `pricing` to have an effect.
   * - "balanced": score = 0.5·cost + 0.3·speed + 0.2·reliability, each rank-
   *   normalized across the candidate slice; unpriced/unobserved signals are
   *   neutral 0.5.
   * - "quality-first": orders by application-recorded outcome quality
   *   (`recordOutcome`) when available, falling back to balanced ordering.
   *   Pair with CallOptions `routing.task` for task-aware selection.
   */
  strategy?: RoutingStrategy;
  /**
   * Relative term weights for the scored strategies ("balanced" and
   * "quality-first"'s fallback ordering). Values are normalized to sum 1;
   * defaults: cost 0.5, speed 0.3, reliability 0.2. Ignored by other
   * strategies.
   */
  weights?: {
    cost?: number;
    speed?: number;
    reliability?: number;
  };
}
