import { parseConfig } from "./config/parse.js";
import type { RouterConfig } from "./config/schema.js";
import {
  RoutingEngine,
  type CallOptions,
  type EngineOptions,
  type OutcomeEvent,
  type RoutingExplanation,
  type RouterStats,
} from "./engine.js";
import type { RawRequestOptions } from "./providers/types.js";
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  EmbeddingRequest,
  EmbeddingResponse,
} from "./types.js";

export interface AIRouterOptions extends EngineOptions {}

/**
 * Public facade. Accepts an already-parsed config or raw unvalidated input
 * (e.g. a JSON file's contents); validation errors are aggregated into a
 * single ConfigError.
 *
 * ```ts
 * const router = new AIRouter({
 *   routes: [
 *     { id: "fast", provider: "openai", model: "gpt-4o-mini", apiKey: process.env.OPENAI_API_KEY },
 *     { id: "backup", provider: "openai-compatible", baseUrl: "https://api.deepseek.com/v1",
 *       model: "deepseek-chat", apiKey: process.env.DEEPSEEK_API_KEY },
 *   ],
 * });
 * const res = await router.complete({ model: "fast", messages: [{ role: "user", content: "hi" }] });
 * ```
 */
export class AIRouter {
  private readonly engine: RoutingEngine;

  constructor(configInput: RouterConfig | unknown, opts: AIRouterOptions = {}) {
    const config = parseConfig(configInput);
    this.engine = new RoutingEngine(config, opts);
  }

  /** Route ids available as `model` values. */
  get routes(): string[] {
    return this.engine.config.routes.map((r) => r.id);
  }

  complete(req: ChatRequest, opts: CallOptions = {}): Promise<ChatResponse> {
    return this.engine.complete(req, opts);
  }

  /**
   * Committed stream: by the time this resolves, the first chunk has arrived
   * and the serving route is final. Post-commit errors surface during
   * iteration.
   */
  stream(req: ChatRequest, opts: CallOptions = {}): Promise<AsyncIterable<ChatChunk>> {
    return this.engine.stream(req, opts);
  }

  /**
   * Embeddings with the same fallback/retry/key-rotation machinery as
   * complete(). Routes whose provider lacks embeddings support are skipped.
   */
  embed(req: EmbeddingRequest, opts: CallOptions = {}): Promise<EmbeddingResponse> {
    return this.engine.embed(req, opts);
  }

  /**
   * Raw escape hatch for one route: verbatim body to the provider endpoint,
   * undecorated Response back. Use for anything the unified layer does not
   * model (multimodal, thinking blocks, server tools, new API fields).
   * No retries, no fallback; rpm limits still apply. Throws
   * RateLimitedError when the route's rpm budget is exhausted.
   */
  raw(routeId: string, opts: RawRequestOptions = {}): Promise<Response> {
    return this.engine.raw(routeId, opts);
  }

  /** Observability snapshot: circuit breakers, key cursors, limiter totals, health. */
  stats(): Promise<RouterStats> {
    return this.engine.stats();
  }

  /**
   * Dry-run routing: evaluate the candidate pipeline (strategy order,
   * capability gate, filter, constraints, circuit state, budgets) without
   * executing a request or consuming rate-limit quota. Returns candidates,
   * rejection reasons, estimated cost, and observed latencies. Never
   * includes credentials.
   */
  explain(req: ChatRequest, opts: Pick<CallOptions, "routing"> = {}): Promise<RoutingExplanation> {
    return this.engine.explain(req, opts);
  }

  /**
   * Record an application-observed outcome (quality, success, latency, cost)
   * for a served request — the input to "quality-first" routing and the
   * foundation for adaptive routing. Applications define quality; unknown
   * route ids are ignored.
   */
  recordOutcome(event: OutcomeEvent): void {
    this.engine.recordOutcome(event);
  }
}
