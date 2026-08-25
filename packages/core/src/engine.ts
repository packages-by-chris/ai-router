/**
 * Routing engine: walks the fallback chain, enforces rate limits, rotates
 * keys, retries with backoff, and owns the streaming commit boundary
 * (fallback is only possible before the first chunk reaches the caller).
 *
 * Failure recovery layers, in order:
 *   1. retry same route+key (retryable kinds, backoff honoring Retry-After)
 *   2. rotate key on same route (rate_limit / auth / permission)
 *   3. next route in the chain
 *
 * Caller cancellation short-circuits everything: once the caller's signal
 * fires, the original abort error propagates — no retry, no key rotation,
 * no fallback.
 */

import type { ModelRoute, RouterConfig, RoutingStrategy } from "./config/schema.js";
import {
  AllRoutesFailedError,
  ConfigError,
  DeadlineExceededError,
  ProviderError,
  RateLimitedError,
  isKeyRelatedKind,
  isRetryableKind,
} from "./errors.js";
import type { AttemptRecord, ErrorKind } from "./errors.js";
import {
  GuardrailBlockedError,
  runGuardrails,
  type Guardrails,
} from "./guardrails.js";
import { MemoryStore } from "./limiter/memory.js";
import type { RateLimitStore } from "./limiter/store.js";
import { errorMessage, toNetworkError, type FetchLike } from "./http/request.js";
import { getPreset } from "./providers/presets.js";
import { getAdapter, isSupported } from "./providers/registry.js";
import type {
  NormalizedRoute,
  ProviderAdapter,
  RawRequestOptions,
} from "./providers/types.js";
import {
  capabilityRejection,
  type CapabilityRequirement,
  type RouteOp,
} from "./routing/capabilities.js";
import { HealthTracker, type RouteHealthSnapshot } from "./routing/health.js";
import { OutcomeTracker, type OutcomeEvent, type OutcomeStats } from "./routing/outcomes.js";
export type { OutcomeEvent, OutcomeStats };
import {
  balancedScores,
  estimateCostUsd,
  orderByScore,
  priceLookup,
  medianLatencyOf,
  successRateOf,
} from "./routing/order.js";
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  TokenPrice,
  Usage,
} from "./types.js";

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 30_000;
const WINDOW_MS = 60_000;
const BACKOFF_BASE_MS = 400;
const BACKOFF_CAP_MS = 8_000;
const BACKOFF_JITTER = 0.25;

/** What happened at each step of routing a single request. */
export type AttemptOutcome =
  | "ok"
  | "error"
  | "retry"
  | "skipped_rate_limit"
  | "skipped_budget"
  | "circuit_open"
  | "unsupported"
  | "capability_mismatch";

export interface AttemptEvent {
  routeId: string;
  provider: string;
  model: string;
  outcome: AttemptOutcome;
  /** Tries consumed on this route (0 for skips; 1-based otherwise). */
  attempts: number;
  keyIndex?: number;
  kind?: ErrorKind;
  message?: string;
  /** Success only: duration of the winning attempt (ms; first chunk for streams). */
  latencyMs?: number;
}

/** End-of-call summary, fired once via CallOptions.onFinish. */
export interface CallSummaryEvent {
  outcome: "ok" | "failed";
  /** Wall time from call start to result/failure (ms). */
  totalMs: number;
  /** Stream only: time to the committed first chunk (ms). */
  ttfbMs?: number;
  /** Serving route on success. */
  routeId?: string;
  provider?: string;
  /**
   * Total adapter tries across all routes (failed routes' tries plus the
   * winning route's). Streams fire this when iteration ends.
   */
  attempts: number;
  /** Failure only: classified error kind when a ProviderError settled the call. */
  kind?: ErrorKind;
  usage?: Usage;
  costUsd?: number;
  cached?: boolean;
}

/**
 * Structured lifecycle log, fired via EngineOptions.onLog /
 * CallOptions.onLog. Covers what onAttempt/onFinish don't: call starts,
 * cache hits, retry delays, pre-flight skips, guardrail vetoes. Callback
 * errors are swallowed — logging must never break routing.
 */
export type LogEvent =
  | { type: "call_start"; ts: number; op: "complete" | "stream" | "embed"; model: string }
  | { type: "cache_hit"; ts: number; model: string }
  | {
      type: "route_skip";
      ts: number;
      routeId: string;
      provider: string;
      reason:
        | "rate_limit"
        | "budget"
        | "circuit_open"
        | "unsupported"
        | "capability"
        | "constraint"
        | "filter";
    }
  | {
      type: "key_skip";
      ts: number;
      routeId: string;
      provider: string;
      /** How many pool keys were on cooldown and passed over. */
      skipped: number;
      /** Index of the key actually selected. */
      keyIndex: number;
    }
  | {
      type: "attempt_retry";
      ts: number;
      routeId: string;
      provider: string;
      attempt: number;
      kind?: ErrorKind;
      /** Backoff delay about to be slept before the next try. */
      delayMs?: number;
    }
  | { type: "guardrail_block"; ts: number; phase: "input" | "output"; guardrail: string; reason?: string };

/** Per-call options (second argument of complete/stream/embed). */
export interface CallOptions {
  /** Observability hook: fired for every routing decision and retry. */
  onAttempt?: (event: AttemptEvent) => void;
  /** Observability hook: fired exactly once when the call settles. */
  onFinish?: (summary: CallSummaryEvent) => void;
  /** Structured lifecycle log for THIS call (engine-level onLog also fires). */
  onLog?: (event: LogEvent) => void;
  /** Caller-provided abort signal. Cancels in-flight requests when fired. */
  signal?: AbortSignal;
  /**
   * Total wall-clock budget for the WHOLE call (ms): routing, all retries,
   * key rotations, fallbacks, and time-to-first-token for streams. Backoff
   * sleeps are truncated at the deadline; per-attempt HTTP timeouts are
   * clamped to the remaining budget. Exceeding it throws
   * DeadlineExceededError — the caller's deadline is never overshot.
   * (For streams the deadline governs acquiring the committed stream, not
   * consuming it.)
   */
  deadlineMs?: number;
  /** Routing controls evaluated per candidate before execution. */
  routing?: RoutingOptions;
}

/**
 * Secret-free view of a route handed to custom filters and explanations.
 * Deliberately excludes keys, headers, and endpoint credentials.
 */
export interface RouteView {
  id: string;
  provider: string;
  model: string;
  weight?: number;
  capabilities?: ModelRoute["capabilities"];
}

/** One evaluated candidate in a routing explanation. */
export interface CandidateExplanation {
  routeId: string;
  provider: string;
  model: string;
  /** "selected" = would serve; "rejected" = eliminated pre-flight; "backup" = next in line. */
  status: "selected" | "rejected" | "backup";
  /**
   * Human-readable reasons: confirmations for the selected candidate,
   * rejection causes for rejected ones. Never contains credentials.
   */
  reasons: string[];
  /** Estimated per-request USD cost (requires `pricing`). */
  estimatedCostUsd?: number;
  /** Observed median total latency (ms), when this route has been used. */
  observedLatencyMs?: number;
  /** Observed median time-to-first-chunk (ms), for stream traffic. */
  observedTtfbMs?: number;
  /** Composite policy score in [0,1] (balanced/quality-first only). */
  score?: number;
}

/** Dry-run routing decision: everything short of an HTTP request. */
export interface RoutingExplanation {
  /** The `model` value that was asked for (a route id). */
  model: string;
  strategy: RoutingStrategy;
  /** Task bucket considered (CallOptions.routing.task). */
  task?: string;
  candidates: CandidateExplanation[];
  selected?: CandidateExplanation;
}

/** Per-call routing policy knobs. All optional, all composable. */
export interface RoutingOptions {
  /**
   * Explicit capability requirements. Combined with requirements inferred
   * from the request itself (tools → tools-capable route, image parts →
   * vision, json_schema → structuredOutput, ...). Only routes that DECLARE
   * capabilities can be eliminated by them.
   */
  require?: CapabilityRequirement;
  /**
   * Application task type for task-aware quality routing
   * (strategy "quality-first" + recordOutcome data).
   */
  task?: string;
  /** Eliminate candidates whose ESTIMATED cost exceeds this USD cap. Unpriced routes pass. */
  maxCostUsd?: number;
  /** Eliminate candidates whose OBSERVED p50 latency exceeds this ms cap. Unobserved routes pass. */
  maxLatencyMs?: number;
  /**
   * Custom predicate over a secret-free route view. Returning false
   * eliminates the candidate with reason "excluded by filter".
   */
  filter?: (route: RouteView) => boolean;
}

/** Context passed to middleware before an adapter call. */
export interface RequestContext {
  routeId: string;
  provider: string;
  /** Provider-side model name (not the route id). */
  model: string;
  request: ChatRequest;
  /** 1-based attempt number for this route. */
  attempt: number;
}

/** Optional per-attempt lifecycle hooks. */
export interface Middleware {
  /** Called before each adapter request. Throw to abort the attempt. */
  beforeRequest?: (ctx: RequestContext) => Promise<void> | void;
  /** Called after a successful adapter response (complete or first stream chunk). */
  afterResponse?: (ctx: RequestContext, response: ChatResponse) => Promise<void> | void;
}

type Notify = (event: AttemptEvent) => void;
const noopNotify: Notify = () => {};

export interface EngineOptions {
  /** Rate-limit storage. Default: in-process sliding window. */
  store?: RateLimitStore;
  /** HTTP client. Default: global fetch. Inject a mock in tests. */
  fetchImpl?: FetchLike;
  /** Backoff sleep. Tests inject a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** Backoff jitter source. Tests inject a constant. */
  rng?: () => number;
  /** Per-attempt lifecycle hooks. */
  middleware?: Middleware;
  /**
   * Circuit breaker. After `threshold` consecutive failures on a route,
   * skip it for `cooldownMs`. Each subsequent breach doubles the cooldown
   * up to `maxCooldownMs` (default: no doubling — fixed cooldown).
   * State is per-engine-instance: multi-replica deployments each trip their
   * own breakers (unlike the rate-limit store, there is no shared backend).
   */
  circuitBreaker?: { threshold?: number; cooldownMs?: number; maxCooldownMs?: number };
  /**
   * USD price per 1M tokens, keyed by route id or provider model name
   * (route id wins). Enables `cost_usd` on responses and usage-bearing
   * stream chunks, and is required for route `budget` enforcement.
   */
  pricing?: Record<string, TokenPrice>;
  /**
   * Simple exact-match response cache for complete(). Key is a hash of the
   * logical request (model + messages + params); value is the full
   * ChatResponse. Bring your own backing store (Map, Redis, ...). Default:
   * disabled.
   */
  responseCache?: {
    get(key: string): Promise<string | undefined | null> | string | undefined | null;
    set(key: string, value: string, ttlMs: number): Promise<void> | void;
    /** Cache entry lifetime in ms. */
    ttlMs: number;
  };
  /**
   * Request/response guardrails. Input guards run once per call before
   * routing (blocked calls never reach a provider); output guards run on
   * complete()/embed() results after spend recording. Streams apply input
   * guards only; raw() bypasses everything.
   */
  guardrails?: Guardrails;
  /**
   * Structured lifecycle log (call_start, cache_hit, route_skip,
   * attempt_retry, guardrail_block). Per-call onLog fires in addition.
   */
  onLog?: (event: LogEvent) => void;
}

/** Observability snapshot of engine-internal routing state. */
export interface RouterStats {
  strategy: RoutingStrategy;
  circuitBreakers: Array<{
    routeId: string;
    failures: number;
    openUntil: number;
    open: boolean;
    /** Graduated-cooldown breach count (0 when fixed cooldowns). */
    opens: number;
  }>;
  keyCursors: Record<string, number>;
  /** Per-route latency EMA in ms (strategy "least-latency" ordering signal). */
  latencies: Record<string, number>;
  /** Per-key limiter totals, when the store supports snapshots. */
  rateLimits: Record<string, number> | null;
  /** Observed per-route health (percentiles, error tallies, key cooldowns). */
  health: RouteHealthSnapshot[];
  /** Application-recorded outcome averages (see recordOutcome). */
  outcomes: OutcomeStats[];
}

export class RoutingEngine {
  private readonly store: RateLimitStore;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rng: () => number;
  private readonly middleware?: Middleware;
  private readonly cbThreshold: number;
  private readonly cbCooldownMs: number;
  private readonly cbMaxCooldownMs: number;
  private readonly pricing?: Record<string, TokenPrice>;
  private readonly responseCache?: EngineOptions["responseCache"];
  private readonly guardrails?: Guardrails;
  private readonly onLog?: (event: LogEvent) => void;
  /** Circuit breaker state: consecutive failures per route and when it opens. */
  private readonly cbState = new Map<string, { failures: number; openUntil: number; opens: number }>();
  /** Round-robin cursor so successive requests start on different keys. */
  private readonly keyCursor = new Map<string, number>();
  /** Latency EMA per route id, ms (strategy "least-latency" ordering). */
  private readonly latencyEma = new Map<string, number>();
  /** Round-robin chain rotation counter (strategy: "round-robin"). */
  private rrCounter = 0;
  /** Observed per-route/per-key health (percentiles, tallies, cooldowns). */
  private readonly health = new HealthTracker();
  /** Application-recorded outcome memory for quality-aware routing. */
  private readonly outcomes = new OutcomeTracker();

  constructor(readonly config: RouterConfig, opts: EngineOptions = {}) {
    this.store = opts.store ?? new MemoryStore();
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.rng = opts.rng ?? Math.random;
    this.middleware = opts.middleware;
    this.cbThreshold = opts.circuitBreaker?.threshold ?? Infinity;
    this.cbCooldownMs = opts.circuitBreaker?.cooldownMs ?? 30_000;
    // No explicit cap -> fixed cooldown (previous behavior).
    this.cbMaxCooldownMs = opts.circuitBreaker?.maxCooldownMs ?? this.cbCooldownMs;
    this.pricing = opts.pricing;
    this.responseCache = opts.responseCache;
    this.guardrails = opts.guardrails;
    this.onLog = opts.onLog;
  }

  /**
   * Fire a lifecycle log event. Callback errors are swallowed — a broken
   * logger must never break routing.
   */
  private emitLog(
    callOnLog: ((event: LogEvent) => void) | undefined,
    event: LogEvent,
  ): void {
    for (const hook of [this.onLog, callOnLog]) {
      if (!hook) continue;
      try {
        hook(event);
      } catch {
        // logging must never break routing
      }
    }
  }

  /**
   * Record + notify + log a pre-flight route skip (circuit open, unsupported
   * provider/embeddings, exhausted rate limit or budget). Shared by
   * complete/stream/embed so the three loops stay in lockstep.
   */
  private skipRoute(
    route: NormalizedRoute,
    outcome: "circuit_open" | "unsupported" | "skipped_budget" | "skipped_rate_limit" | "capability_mismatch",
    message: string,
    attempts: AttemptRecord[],
    notify: Notify,
    callOnLog?: (event: LogEvent) => void,
  ): void {
    const record: AttemptRecord = {
      routeId: route.id, provider: route.provider, model: route.model,
      outcome, attempts: 0, message,
    };
    attempts.push(record);
    notify(record);
    this.emitLog(callOnLog, {
      type: "route_skip",
      ts: Date.now(),
      routeId: route.id,
      provider: route.provider,
      reason:
        outcome === "circuit_open"
          ? "circuit_open"
          : outcome === "unsupported"
            ? "unsupported"
            : outcome === "capability_mismatch"
              ? "capability"
              : outcome === "skipped_budget"
                ? "budget"
                : "rate_limit",
    });
  }

  async complete(req: ChatRequest, opts: CallOptions = {}): Promise<ChatResponse> {
    const startedAt = Date.now();
    const notify = opts.onAttempt ?? noopNotify;
    const onFinish = opts.onFinish;
    const signal = opts.signal;
    if (signal?.aborted) throw abortFrom(signal);
    const deadlineAt = opts.deadlineMs !== undefined ? startedAt + opts.deadlineMs : undefined;
    const { deadlineMs } = opts;
    const routing = opts.routing;
    const inputTokens = estimateTokens(req);

    const attempts: AttemptRecord[] = [];

    try {
      this.emitLog(opts.onLog, { type: "call_start", ts: Date.now(), op: "complete", model: req.model });

      // Input guardrails run once per logical call, before routing AND
      // before the cache — a blocked request never reaches any provider.
      try {
        req = await runGuardrails("input", this.guardrails?.input, req);
      } catch (err) {
        if (err instanceof GuardrailBlockedError) {
          this.emitLog(opts.onLog, {
            type: "guardrail_block",
            ts: Date.now(),
            phase: "input",
            guardrail: err.guardrail,
            ...(err.reason !== undefined ? { reason: err.reason } : {}),
          });
        }
        throw err;
      }

      // Exact-match response cache (complete only): hash the logical request.
      if (this.responseCache) {
        const key = responseCacheKey(req);
        try {
          const hit = await this.responseCache.get(key);
          if (hit) {
            const cachedResponse = JSON.parse(hit) as ChatResponse;
            this.emitLog(opts.onLog, { type: "cache_hit", ts: Date.now(), model: req.model });
            onFinish?.({
              outcome: "ok",
              totalMs: Date.now() - startedAt,
              routeId: cachedResponse.provider,
              attempts: 0,
              usage: cachedResponse.usage ?? undefined,
              costUsd: cachedResponse.cost_usd,
              cached: true,
            });
            return cachedResponse;
          }
        } catch {
          // Cache failures never block routing.
        }
      }
      let served: { route: NormalizedRoute; value: ChatResponse; tries: number } | undefined;

      for (const route of this.resolveChain(req, "complete", routing?.task)) {
        if (signal?.aborted) throw abortFrom(signal);
        this.assertDeadline(deadlineAt, deadlineMs);
        if (this.cbIsOpen(route.id)) {
          this.skipRoute(route, "circuit_open", "circuit breaker open", attempts, notify, opts.onLog);
          continue;
        }

        const rejection = this.routingRejection(route, req, "complete", inputTokens, routing);
        if (rejection) {
          this.skipRoute(route, "capability_mismatch", rejection.message, attempts, notify, opts.onLog);
          continue;
        }

        let adapter: ProviderAdapter;
        try {
          adapter = getAdapter(route.adapterId ?? route.provider);
        } catch (err) {
          this.skipRoute(route, "unsupported", errorMessage(err), attempts, notify, opts.onLog);
          continue;
        }

        const overBudget = await this.budgetExhausted(route);
        if (overBudget || !(await this.takeBudget(route))) {
          this.skipRoute(
            route,
            overBudget ? "skipped_budget" : "skipped_rate_limit",
            overBudget ? "usd spend budget exhausted" : "rate limit budget exhausted pre-flight",
            attempts, notify, opts.onLog,
          );
          continue;
        }

        const timing = { latencyMs: 0 };
        const result = await this.attemptWithRetry(
          route, notify, signal,
          (key, tries, keyIndex) =>
            this.completeOnce(adapter, route, key, tries, keyIndex, req, signal, notify, timing,
              deadlineAt),
          deadlineAt, deadlineMs,
          opts.onLog,
        );
        if (result.ok) {
          this.cbRecordSuccess(route.id);
          served = { route, value: result.value, tries: result.tries };
          break;
        }
        this.cbRecordFailure(route.id);
        attempts.push(result.attempt);
      }

      if (!served) throw new AllRoutesFailedError(attempts);

      const { route } = served;
      let value = served.value;
      const usage = value.usage;
      if (route.limits.tpm !== undefined && usage) {
        await this.store.record(`${route.id}:tpm`, usage.total_tokens, WINDOW_MS);
      }
      const price = this.priceFor(route);
      if (price && usage) {
        value.cost_usd = computeCost(usage, price);
        if (route.budget) {
          // Spend recorded in micro-dollars (integer) so every store,
          // including the Redis Lua parser, stays integer-safe.
          await this.store.record(
            `${route.id}:usd`,
            Math.round(value.cost_usd * 1e6),
            route.budget.windowMs ?? WINDOW_MS,
          );
        }
      }
      // Output guardrails run AFTER spend recording — the provider charged
      // regardless of the verdict. Blocked outputs do not fall back.
      try {
        value = await runGuardrails("output", this.guardrails?.output, value);
      } catch (err) {
        if (err instanceof GuardrailBlockedError) {
          this.emitLog(opts.onLog, {
            type: "guardrail_block",
            ts: Date.now(),
            phase: "output",
            guardrail: err.guardrail,
            ...(err.reason !== undefined ? { reason: err.reason } : {}),
          });
        }
        throw err;
      }
      if (this.responseCache) {
        const key = responseCacheKey(req);
        void Promise.resolve(this.responseCache.set(key, JSON.stringify(value), this.responseCache.ttlMs)).catch(() => {});
      }
      onFinish?.({
        outcome: "ok",
        totalMs: Date.now() - startedAt,
        routeId: route.id,
        provider: route.provider,
        attempts: totalTries(attempts, served.tries),
        usage: usage ?? undefined,
        costUsd: value.cost_usd,
      });
      return value;
    } catch (err) {
      onFinish?.({
        outcome: "failed",
        totalMs: Date.now() - startedAt,
        attempts: totalTries(attempts, 0),
        kind: failureKind(err),
      });
      throw err;
    }
  }

  /**
   * Returns a committed stream: the first chunk has already arrived, so the
   * route is final. Errors thrown mid-iteration happen after commit and
   * surface to the caller — a provider swap mid-stream is impossible.
   */
  async stream(req: ChatRequest, opts: CallOptions = {}): Promise<AsyncIterable<ChatChunk>> {
    const startedAt = Date.now();
    const notify = opts.onAttempt ?? noopNotify;
    const onFinish = opts.onFinish;
    const signal = opts.signal;
    if (signal?.aborted) throw abortFrom(signal);
    const deadlineAt = opts.deadlineMs !== undefined ? startedAt + opts.deadlineMs : undefined;
    const { deadlineMs } = opts;
    const routing = opts.routing;
    const inputTokens = estimateTokens(req);
    const attempts: AttemptRecord[] = [];

    try {
      this.emitLog(opts.onLog, { type: "call_start", ts: Date.now(), op: "stream", model: req.model });
      // Input guardrails apply to streams; output guards do NOT (scanning
      // would require buffering, defeating streaming).
      try {
        req = await runGuardrails("input", this.guardrails?.input, req);
      } catch (err) {
        if (err instanceof GuardrailBlockedError) {
          this.emitLog(opts.onLog, {
            type: "guardrail_block",
            ts: Date.now(),
            phase: "input",
            guardrail: err.guardrail,
            ...(err.reason !== undefined ? { reason: err.reason } : {}),
          });
        }
        throw err;
      }
      for (const route of this.resolveChain(req, "stream", routing?.task)) {
        if (signal?.aborted) throw abortFrom(signal);
        this.assertDeadline(deadlineAt, deadlineMs);
        if (this.cbIsOpen(route.id)) {
          this.skipRoute(route, "circuit_open", "circuit breaker open", attempts, notify, opts.onLog);
          continue;
        }

        const rejection = this.routingRejection(route, req, "stream", inputTokens, routing);
        if (rejection) {
          this.skipRoute(route, "capability_mismatch", rejection.message, attempts, notify, opts.onLog);
          continue;
        }

        let adapter: ProviderAdapter;
        try {
          adapter = getAdapter(route.adapterId ?? route.provider);
        } catch (err) {
          this.skipRoute(route, "unsupported", errorMessage(err), attempts, notify, opts.onLog);
          continue;
        }

        const overBudget = await this.budgetExhausted(route);
        if (overBudget || !(await this.takeBudget(route))) {
          this.skipRoute(
            route,
            overBudget ? "skipped_budget" : "skipped_rate_limit",
            overBudget ? "usd spend budget exhausted" : "rate limit budget exhausted pre-flight",
            attempts, notify, opts.onLog,
          );
          continue;
        }

        const timing = { latencyMs: 0 };
        const result = await this.attemptWithRetry(
          route, notify, signal,
          (key, tries, keyIndex) =>
            this.streamCommit(adapter, route, key, tries, keyIndex, req, signal, notify, timing,
              deadlineAt),
          deadlineAt, deadlineMs,
          opts.onLog,
        );
        if (result.ok) {
          this.cbRecordSuccess(route.id);
          // Summary fires when iteration ends (ok or failed) so usage/costUsd
          // come from the final usage-bearing chunk, not the first.
          return this.continueStream(route, result.value.iterator, result.value.first, {
            startedAt,
            ttfbMs: timing.latencyMs,
            attempts: totalTries(attempts, result.tries),
            onFinish,
          });
        }
        this.cbRecordFailure(route.id);
        attempts.push(result.attempt);
      }

      throw new AllRoutesFailedError(attempts);
    } catch (err) {
      // Pre-commit failures only: post-commit summaries are fired by
      // continueStream when iteration ends.
      onFinish?.({
        outcome: "failed",
        totalMs: Date.now() - startedAt,
        attempts: totalTries(attempts, 0),
        kind: failureKind(err),
      });
      throw err;
    }
  }

  /**
   * Embeddings with the same fallback/retry/key-rotation machinery as
   * complete(). Providers without an embeddings API are recorded as
   * unsupported attempts and routing falls through to the next route.
   */
  async embed(req: EmbeddingRequest, opts: CallOptions = {}): Promise<EmbeddingResponse> {
    const startedAt = Date.now();
    const notify = opts.onAttempt ?? noopNotify;
    const onFinish = opts.onFinish;
    const signal = opts.signal;
    if (signal?.aborted) throw abortFrom(signal);
    const deadlineAt = opts.deadlineMs !== undefined ? startedAt + opts.deadlineMs : undefined;
    const { deadlineMs } = opts;
    const routing = opts.routing;
    const attempts: AttemptRecord[] = [];

    try {
      this.emitLog(opts.onLog, { type: "call_start", ts: Date.now(), op: "embed", model: req.model });
      // Input guardrails apply to embedding requests too. Output guards
      // target ChatResponse shapes and are skipped for embed(). Guards see a
      // ChatRequest view of the input; a `replace` verdict is mapped back
      // onto req.input (array inputs collapse to the joined string).
      const probe: ChatRequest = {
        model: req.model,
        messages: [
          { role: "user", content: Array.isArray(req.input) ? req.input.join("\n") : req.input },
        ],
      };
      const inputTokens = estimateTokens(probe);
      try {
        const guarded = await runGuardrails("input", this.guardrails?.input, probe);
        if (guarded !== probe) {
          const content = guarded.messages[0]?.content;
          if (typeof content === "string") req = { ...req, input: content };
        }
      } catch (err) {
        if (err instanceof GuardrailBlockedError) {
          this.emitLog(opts.onLog, {
            type: "guardrail_block",
            ts: Date.now(),
            phase: "input",
            guardrail: err.guardrail,
            ...(err.reason !== undefined ? { reason: err.reason } : {}),
          });
        }
        throw err;
      }
      let served: { route: NormalizedRoute; value: EmbeddingResponse; tries: number } | undefined;

      for (const route of this.resolveChain(probe, "embed", routing?.task)) {
        if (signal?.aborted) throw abortFrom(signal);
        this.assertDeadline(deadlineAt, deadlineMs);
        if (this.cbIsOpen(route.id)) {
          this.skipRoute(route, "circuit_open", "circuit breaker open", attempts, notify, opts.onLog);
          continue;
        }

        const rejection = this.routingRejection(route, probe, "embed", inputTokens, routing);
        if (rejection) {
          this.skipRoute(route, "capability_mismatch", rejection.message, attempts, notify, opts.onLog);
          continue;
        }

        let adapter: ProviderAdapter;
        try {
          adapter = getAdapter(route.adapterId ?? route.provider);
        } catch (err) {
          this.skipRoute(route, "unsupported", errorMessage(err), attempts, notify, opts.onLog);
          continue;
        }
        if (!adapter.embed) {
          this.skipRoute(
            route, "unsupported",
            new ConfigError(`${route.provider} does not support embeddings`).message,
            attempts, notify, opts.onLog,
          );
          continue;
        }

        if (!(await this.takeBudget(route))) {
          this.skipRoute(route, "skipped_rate_limit", "rate limit budget exhausted pre-flight", attempts, notify, opts.onLog);
          continue;
        }

        const result = await this.attemptWithRetry(route, notify, signal, (key, tries, keyIndex) =>
          this.embedOnce(adapter, route, key, tries, keyIndex, req, signal, notify, deadlineAt),
          deadlineAt, deadlineMs, opts.onLog,
        );
        if (result.ok) {
          this.cbRecordSuccess(route.id);
          served = { route, value: result.value, tries: result.tries };
          break;
        }
        this.cbRecordFailure(route.id);
        attempts.push(result.attempt);
      }

      if (!served) throw new AllRoutesFailedError(attempts);

      const { route, value } = served;
      const usage = value.usage;
      if (route.limits.tpm !== undefined && usage) {
        await this.store.record(`${route.id}:tpm`, usage.total_tokens, WINDOW_MS);
      }
      const price = this.priceFor(route);
      if (price && usage) value.cost_usd = computeCost(usage, price);
      onFinish?.({
        outcome: "ok",
        totalMs: Date.now() - startedAt,
        routeId: route.id,
        provider: route.provider,
        attempts: totalTries(attempts, served.tries),
        usage: usage ?? undefined,
        costUsd: value.cost_usd,
      });
      return value;
    } catch (err) {
      onFinish?.({
        outcome: "failed",
        totalMs: Date.now() - startedAt,
        attempts: totalTries(attempts, 0),
        kind: failureKind(err),
      });
      throw err;
    }
  }

  /**
   * Raw escape hatch: send a verbatim request to ONE route's provider
   * endpoint. No translation, no retries, no fallback — the caller owns the
   * request shape and the Response (including non-2xx statuses and raw
   * streams). rpm budgets still gate the call; tpm is skipped (cost unknown
   * pre-flight). The key-pool cursor is shared with normal routing, so raw
   * and unified calls rotate keys together.
   */
  async raw(routeId: string, opts: RawRequestOptions = {}): Promise<Response> {
    const route = this.config.routes.find((r) => r.id === routeId);
    if (!route) {
      const known = this.config.routes.map((r) => r.id).join(", ");
      throw new ConfigError(`unknown route id "${routeId}" (known route ids: ${known})`);
    }
    const normalized = normalizeRoute(route);
    const adapter = getAdapter(normalized.adapterId ?? normalized.provider);

    if (normalized.limits.rpm !== undefined) {
      const decision = await this.store.take(
        `${normalized.id}:rpm`,
        1,
        WINDOW_MS,
        normalized.limits.rpm,
      );
      if (!decision.allowed) throw new RateLimitedError(normalized.id, decision.retryAfterMs);
    }

    const keyIndex = this.nextKeyIndex(normalized);
    const key = normalized.keyPool[keyIndex % normalized.keyPool.length] as string;
    return adapter.raw(normalized, key, opts, { fetchImpl: this.fetchImpl, signal: opts.signal });
  }

  /** Snapshot of circuit-breaker state, key cursors, limiter totals, health. */
  async stats(): Promise<RouterStats> {
    const rateLimits = this.store.snapshot
      ? await this.store.snapshot()
      : null;
    return {
      strategy: this.config.strategy ?? "fallback",
      circuitBreakers: [...this.cbState.entries()].map(([routeId, s]) => ({
        routeId,
        failures: s.failures,
        openUntil: s.openUntil,
        open: Date.now() < s.openUntil,
        opens: s.opens,
      })),
      keyCursors: Object.fromEntries(this.keyCursor),
      latencies: Object.fromEntries(this.latencyEma),
      rateLimits,
      health: this.health.snapshot(),
      outcomes: this.outcomes.snapshot(),
    };
  }

  /**
   * Record an application-observed outcome for a completed call — the input
   * to quality-aware ("quality-first") and future adaptive routing.
   * Applications define quality; the router only aggregates it (EMA per
   * task+route). Unknown route ids are ignored, never thrown.
   */
  recordOutcome(event: OutcomeEvent): void {
    if (!this.config.routes.some((r) => r.id === event.routeId)) return;
    this.outcomes.record(event);
  }

  /**
   * Dry-run routing: evaluate the full candidate pipeline (strategy order,
   * capability gate, filter, constraints, circuit state, budgets) WITHOUT
   * executing anything and WITHOUT consuming rate-limit quota. The first
   * candidate that passes every read-only check is "selected"; note the
   * real call may still differ if rpm limits trip or providers fail.
   */
  async explain(req: ChatRequest, opts: Pick<CallOptions, "routing"> = {}): Promise<RoutingExplanation> {
    const strategy = this.config.strategy ?? "fallback";
    const task = opts.routing?.task;
    const chain = this.resolveChain(req, "complete", task);
    const inputTokens = estimateTokens(req);
    const candidates: CandidateExplanation[] = [];
    let selected: CandidateExplanation | undefined;

    for (const route of chain) {
      const price = priceLookup(this.pricing, route.id, route.model);
      const estCost = price ? estimateCostUsd(price, inputTokens, req.max_tokens) : undefined;
      const healthSnap = this.health.snapshot().find((h) => h.routeId === route.id);
      const entry: CandidateExplanation = {
        routeId: route.id,
        provider: route.provider,
        model: route.model,
        status: "backup",
        reasons: [],
        ...(estCost !== undefined ? { estimatedCostUsd: estCost } : {}),
        ...(healthSnap?.p50LatencyMs !== undefined ? { observedLatencyMs: healthSnap.p50LatencyMs } : {}),
        ...(healthSnap?.p50TtfbMs !== undefined ? { observedTtfbMs: healthSnap.p50TtfbMs } : {}),
      };
      candidates.push(entry);

      // Once a candidate is selected the rest stay unevaluated backups.
      if (selected) continue;

      const reject = (reason: string): void => {
        entry.status = "rejected";
        entry.reasons.push(reason);
      };

      if (this.cbIsOpen(route.id)) {
        reject("circuit breaker open");
        continue;
      }
      const rejection = this.routingRejection(route, req, "complete", inputTokens, opts.routing);
      if (rejection) {
        reject(rejection.message);
        continue;
      }
      try {
        getAdapter(route.adapterId ?? route.provider);
      } catch (err) {
        reject(errorMessage(err));
        continue;
      }

      if (route.budget && this.store.used) {
        try {
          const used = await this.windowTotal(`${route.id}:usd`, route.budget.windowMs ?? WINDOW_MS);
          if (used >= Math.round(route.budget.usd * 1e6)) {
            reject("usd spend budget exhausted");
            continue;
          }
        } catch {
          // store read failure fails open, same as execution
        }
      }
      if (
        route.limits.tpm !== undefined &&
        (await this.windowTotal(`${route.id}:tpm`, WINDOW_MS)) >= route.limits.tpm
      ) {
        reject("token budget exhausted pre-flight");
        continue;
      }

      // Eligible — first one wins.
      entry.status = "selected";
      if (route.capabilities) {
        entry.reasons.push("declared capabilities satisfy the request");
      }
      if (healthSnap && healthSnap.successes + healthSnap.failures > 0) {
        entry.reasons.push(`healthy (${Math.round(healthSnap.successRate * 100)}% recent success)`);
      }
      if (estCost !== undefined) {
        entry.reasons.push(`estimated cost $${estCost}`);
      }
      if (healthSnap?.p50LatencyMs !== undefined) {
        entry.reasons.push(`observed p50 ${healthSnap.p50LatencyMs}ms`);
      }
      if (entry.reasons.length === 0) entry.reasons.push("highest-priority eligible candidate");
      selected = entry;
    }

    return {
      model: req.model,
      strategy,
      ...(task !== undefined ? { task } : {}),
      candidates,
      ...(selected ? { selected } : {}),
    };
  }

  // ------------------------------------------------------------------ internals

  /** Secret-free view handed to custom filters and explanations. */
  private routeView(route: NormalizedRoute): RouteView {
    return {
      id: route.id,
      provider: route.provider,
      model: route.model,
      ...(route.weight !== undefined ? { weight: route.weight } : {}),
      ...(route.capabilities !== undefined ? { capabilities: route.capabilities } : {}),
    };
  }

  /**
   * Per-candidate pre-execution gate shared by complete/stream/embed and
   * explain(): capability requirements (explicit + request-inferred), custom
   * filter, cost and latency constraints. Returns why the candidate must be
   * skipped, or null when eligible.
   */
  private routingRejection(
    route: NormalizedRoute,
    req: ChatRequest,
    op: RouteOp,
    inputTokens: number,
    routing: RoutingOptions | undefined,
  ): { message: string; kind: "capability" | "constraint" | "filter" } | null {
    const capReason = capabilityRejection(
      route.capabilities,
      req,
      op,
      routing?.require,
      inputTokens,
    );
    if (capReason) return { message: capReason, kind: "capability" };

    if (routing?.filter && !routing.filter(this.routeView(route))) {
      return { message: "excluded by custom filter", kind: "filter" };
    }

    if (routing?.maxCostUsd !== undefined) {
      const price = priceLookup(this.pricing, route.id, route.model);
      if (price) {
        const est = estimateCostUsd(price, inputTokens, req.max_tokens);
        if (est > routing.maxCostUsd) {
          return {
            message: `estimated cost $${est} exceeds maxCostUsd $${routing.maxCostUsd}`,
            kind: "constraint",
          };
        }
      }
    }

    if (routing?.maxLatencyMs !== undefined) {
      const observed = this.health.medianLatency(route.id);
      if (observed !== undefined && observed > routing.maxLatencyMs) {
        return {
          message: `observed p50 latency ${observed}ms exceeds maxLatencyMs ${routing.maxLatencyMs}`,
          kind: "constraint",
        };
      }
    }

    return null;
  }

  /** Throw when the call's wall-clock deadline has passed. */
  private assertDeadline(deadlineAt: number | undefined, deadlineMs: number | undefined): void {
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      throw new DeadlineExceededError(deadlineMs ?? 0);
    }
  }

  /**
   * Compose caller cancellation + deadline into ONE signal for a single
   * attempt. Fixes two things at once:
   *   - caller abort now cancels in-flight STREAM bodies (previously only
   *     the HTTP headers were cancellable once fetch resolved);
   *   - deadline breaches abort the underlying request instead of letting
   *     it run to the provider's own timeout.
   * dispose() MUST run when the attempt's response/stream is finished.
   */
  private linkAttempt(caller: AbortSignal | undefined, deadlineAt: number | undefined): {
    signal: AbortSignal;
    dispose(): void;
  } {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abortFromCaller = () =>
      ctrl.abort(caller?.reason ?? new DOMException("This operation was aborted", "AbortError"));
    if (caller?.aborted) abortFromCaller();
    else if (caller) caller.addEventListener("abort", abortFromCaller, { once: true });
    if (deadlineAt !== undefined) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        ctrl.abort(new DOMException("deadline exceeded", "TimeoutError"));
      } else {
        timer = setTimeout(
          () => ctrl.abort(new DOMException("deadline exceeded", "TimeoutError")),
          remaining,
        );
      }
    }
    return {
      signal: ctrl.signal,
      dispose() {
        if (timer !== undefined) clearTimeout(timer);
        caller?.removeEventListener("abort", abortFromCaller);
      },
    };
  }

  private async completeOnce(
    adapter: ProviderAdapter,
    route: NormalizedRoute,
    key: string,
    tries: number,
    keyIndex: number,
    req: ChatRequest,
    signal: AbortSignal | undefined,
    notify: Notify,
    timing: { latencyMs: number },
    deadlineAt: number | undefined,
  ): Promise<ChatResponse> {
    await this.fireBeforeRequest(route, req, tries);
    // Clamp the attempt to whatever budget remains; a shared controller also
    // keeps caller cancellation live for the whole body read.
    const link = this.linkAttempt(signal, deadlineAt);
    try {
      const t0 = Date.now();
      const value = await adapter.complete(
        { ...route, timeoutMs: this.effectiveTimeoutMs(route, deadlineAt) },
        key,
        req,
        { fetchImpl: this.fetchImpl, signal: link.signal },
      );
      timing.latencyMs = Date.now() - t0;
      this.recordLatency(route.id, timing.latencyMs);
      this.health.recordSuccess(route.id, { latencyMs: timing.latencyMs });
      await this.fireAfterResponse(route, req, tries, value);
      notify({
        routeId: route.id, provider: route.provider, model: route.model,
        outcome: "ok", attempts: tries, keyIndex, latencyMs: timing.latencyMs,
      });
      return value;
    } finally {
      link.dispose();
    }
  }

  private async streamCommit(
    adapter: ProviderAdapter,
    route: NormalizedRoute,
    key: string,
    tries: number,
    keyIndex: number,
    req: ChatRequest,
    signal: AbortSignal | undefined,
    notify: Notify,
    timing: { latencyMs: number },
    deadlineAt: number | undefined,
  ): Promise<{ iterator: AsyncIterator<ChatChunk>; first: ChatChunk }> {
    await this.fireBeforeRequest(route, req, tries);
    // The link outlives this method for streams: it must stay armed so a
    // caller abort (or deadline) cancels the upstream HTTP body mid-stream.
    // Ownership transfers to the disposing wrapper below.
    const link = this.linkAttempt(signal, deadlineAt);
    let iterator: AsyncIterator<ChatChunk> | undefined;
    try {
      const iterable = await adapter.stream(
        { ...route, timeoutMs: this.effectiveTimeoutMs(route, deadlineAt) },
        key,
        req,
        { fetchImpl: this.fetchImpl, signal: link.signal },
      );
      iterator = iterable[Symbol.asyncIterator]();
      const t0 = Date.now();
      const first = route.streamIdleTimeoutMs
        ? await this.nextWithTimeout(iterator, route.streamIdleTimeoutMs, route.provider)
        : await iterator.next();
      timing.latencyMs = Date.now() - t0;
      if (first.done) {
        this.recordLatency(route.id, timing.latencyMs);
        this.health.recordSuccess(route.id, { latencyMs: timing.latencyMs });
        notify({
          routeId: route.id, provider: route.provider, model: route.model,
          outcome: "ok", attempts: tries, keyIndex, latencyMs: timing.latencyMs,
        });
        return { iterator: disposeOnEnd(iterator, link.dispose), first: emptyChunk() };
      }
      this.recordLatency(route.id, timing.latencyMs);
      this.health.recordSuccess(route.id, { ttfbMs: timing.latencyMs });
      notify({
        routeId: route.id, provider: route.provider, model: route.model,
        outcome: "ok", attempts: tries, keyIndex, latencyMs: timing.latencyMs,
      });
      // Fire afterResponse with a synthetic response from first chunk metadata.
      await this.fireAfterResponse(route, req, tries, {
        id: first.value.id,
        model: first.value.model,
        provider: first.value.provider,
        created: 0,
        choices: [{ index: 0, message: { role: first.value.delta.role ?? "assistant", content: first.value.delta.content ?? null }, finish_reason: null }],
        usage: first.value.usage ?? null,
      });
      return { iterator: disposeOnEnd(iterator, link.dispose), first: first.value };
    } catch (err) {
      // Pre-commit failure (or first-chunk timeout): tear everything down —
      // the engine may fall back to another route.
      if (iterator) void Promise.resolve(iterator.return?.()).catch(() => {});
      link.dispose();
      throw err;
    }
  }

  private async embedOnce(
    adapter: ProviderAdapter,
    route: NormalizedRoute,
    key: string,
    tries: number,
    keyIndex: number,
    req: EmbeddingRequest,
    signal: AbortSignal | undefined,
    notify: Notify,
    deadlineAt: number | undefined,
  ): Promise<EmbeddingResponse> {
    await this.fireBeforeRequest(route, { model: req.model, messages: [] }, tries);
    const link = this.linkAttempt(signal, deadlineAt);
    try {
      const value = await adapter.embed!(
        { ...route, timeoutMs: this.effectiveTimeoutMs(route, deadlineAt) },
        key,
        req,
        { fetchImpl: this.fetchImpl, signal: link.signal },
      );
      notify({
        routeId: route.id, provider: route.provider, model: route.model,
        outcome: "ok", attempts: tries, keyIndex,
      });
      return value;
    } finally {
      link.dispose();
    }
  }

  /** Per-attempt HTTP timeout clamped to the caller's remaining deadline. */
  private effectiveTimeoutMs(route: NormalizedRoute, deadlineAt: number | undefined): number {
    if (deadlineAt === undefined) return route.timeoutMs;
    const remaining = deadlineAt - Date.now();
    return Math.max(1, Math.min(route.timeoutMs, remaining));
  }

  /**
   * Shared retry/rotate loop. `op` performs one attempt (hooks + adapter call
   * + ok notification). Caller cancellation inside `op` or between attempts
   * propagates immediately — never retried, never falls back. A breached
   * deadline throws DeadlineExceededError for the whole call.
   */
  private async attemptWithRetry<T>(
    route: NormalizedRoute,
    notify: Notify,
    signal: AbortSignal | undefined,
    op: (key: string, tries: number, keyIndex: number) => Promise<T>,
    deadlineAt?: number,
    deadlineMs?: number,
    callOnLog?: (event: LogEvent) => void,
  ): Promise<{ ok: true; value: T; tries: number } | { ok: false; attempt: AttemptRecord }> {
    const maxRetries = route.maxRetries;
    const poolSize = route.keyPool.length;
    let keyIndex = this.nextKeyIndex(route);
    let tries = 0;
    let retries = 0;
    let keysExhausted = 0;
    let last: ProviderError | undefined;

    for (;;) {
      if (signal?.aborted) throw abortFrom(signal);
      this.assertDeadline(deadlineAt, deadlineMs);
      // Skip keys known to be cooling down (rate-limit/auth Retry-After) so
      // we don't burn attempts on keys that just told us to back off.
      let effectiveIndex = keyIndex % poolSize;
      const picked = this.health.pickKey(route.id, effectiveIndex, poolSize);
      if (picked !== null && picked !== effectiveIndex) {
        const skipped = (picked - effectiveIndex + poolSize) % poolSize;
        this.emitLog(callOnLog, {
          type: "key_skip",
          ts: Date.now(),
          routeId: route.id,
          provider: route.provider,
          skipped,
          keyIndex: picked,
        });
        effectiveIndex = picked;
      }
      const key = route.keyPool[effectiveIndex] as string;
      tries++;
      try {
        const value = await op(key, tries, effectiveIndex);
        return { ok: true, value, tries };
      } catch (err) {
        if (signal?.aborted) throw err;
        last = toProviderError(err, route.provider);
        this.health.recordFailure(route.id, last.kind, {
          keyIndex: effectiveIndex,
          ...(last.retryAfterMs !== undefined ? { retryAfterMs: last.retryAfterMs } : {}),
        });
        // Rate limit / auth / permission: try the next key immediately.
        // If all keys exhausted (or only one key), fall back to next route.
        if (isKeyRelatedKind(last.kind)) {
          keysExhausted++;
          if (keysExhausted >= poolSize) break;
          const prevKeyIndex = effectiveIndex;
          keyIndex++;
          notify({
            routeId: route.id, provider: route.provider, model: route.model,
            outcome: "retry", attempts: tries, keyIndex: prevKeyIndex,
            kind: last.kind, message: last.message,
          });
          continue;
        }
        if (!isRetryableKind(last.kind)) break;
        if (retries < maxRetries) {
          retries++;
          notify({
            routeId: route.id, provider: route.provider, model: route.model,
            outcome: "retry", attempts: tries, keyIndex: effectiveIndex,
            kind: last.kind, message: last.message,
          });
          let delayMs = this.backoffMs(retries, last.retryAfterMs);
          // Never sleep past the caller's deadline.
          if (deadlineAt !== undefined) {
            delayMs = Math.max(0, Math.min(delayMs, deadlineAt - Date.now()));
          }
          this.emitLog(callOnLog, {
            type: "attempt_retry",
            ts: Date.now(),
            routeId: route.id,
            provider: route.provider,
            attempt: tries,
            ...(last.kind !== undefined ? { kind: last.kind } : {}),
            delayMs,
          });
          await this.sleep(delayMs);
        } else {
          break;
        }
      }
    }

    const attempt = failedAttempt(route, tries, keyIndex, last);
    notify(attempt);
    return { ok: false, attempt };
  }

  /**
   * Yields the committed first chunk, then the rest. Fires the call's single
   * onFinish when iteration ends — ok with usage/costUsd from the last
   * usage-bearing chunk, or failed with the classified kind on mid-stream
   * errors. Abandoned streams (caller breaks early) fire nothing.
   */
  private async *continueStream(
    route: NormalizedRoute,
    iterator: AsyncIterator<ChatChunk>,
    first: ChatChunk,
    summary: {
      startedAt: number;
      ttfbMs: number;
      attempts: number;
      onFinish?: (s: CallSummaryEvent) => void;
    },
  ): AsyncGenerator<ChatChunk> {
    let usage: Usage | undefined;
    let costUsd: number | undefined;
    try {
      if (first.usage) usage = first.usage;
      if (first.cost_usd !== undefined) costUsd = first.cost_usd;
      yield first;
      for (;;) {
        const next = route.streamIdleTimeoutMs
          ? await this.nextWithTimeout(iterator, route.streamIdleTimeoutMs, route.provider)
          : await iterator.next();
        if (next.done) break;
        const chunk = next.value;
        if (chunk.usage && route.limits.tpm !== undefined) {
          await this.store.record(`${route.id}:tpm`, chunk.usage.total_tokens, WINDOW_MS);
        }
        const price = this.priceFor(route);
        if (price && chunk.usage) {
          chunk.cost_usd = computeCost(chunk.usage, price);
          // Post-hoc spend accounting feeds the route's rolling budget
          // (micro-dollar integers — see complete()).
          if (route.budget) {
            await this.store.record(
              `${route.id}:usd`,
              Math.round(chunk.cost_usd * 1e6),
              route.budget.windowMs ?? WINDOW_MS,
            );
          }
        }
        if (chunk.usage) usage = chunk.usage;
        if (chunk.cost_usd !== undefined) costUsd = chunk.cost_usd;
        yield chunk;
      }
      summary.onFinish?.({
        outcome: "ok",
        totalMs: Date.now() - summary.startedAt,
        ttfbMs: summary.ttfbMs,
        routeId: route.id,
        provider: route.provider,
        attempts: summary.attempts,
        ...(usage !== undefined ? { usage } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
      });
    } catch (err) {
      summary.onFinish?.({
        outcome: "failed",
        totalMs: Date.now() - summary.startedAt,
        ttfbMs: summary.ttfbMs,
        routeId: route.id,
        provider: route.provider,
        attempts: summary.attempts,
        kind: failureKind(err),
      });
      throw err;
    }
  }

  /**
   * iterator.next() racing an idle timer. On timeout the underlying iterator
   * gets a best-effort return() and a retryable "timeout" ProviderError is
   * thrown (pre-commit: triggers fallback; post-commit: surfaces to caller).
   */
  private nextWithTimeout(
    iterator: AsyncIterator<ChatChunk>,
    ms: number,
    provider: string,
  ): Promise<IteratorResult<ChatChunk>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void Promise.resolve()
          .then(() => iterator.return?.())
          .catch(() => {});
        reject(new ProviderError(provider, "timeout", `no stream data for ${ms}ms`));
      }, ms);
    });
    return Promise.race([iterator.next(), timeout]).finally(() => clearTimeout(timer!));
  }

  /**
   * Candidate slice for a request: routes from the requested id onward,
   * reordered by the configured strategy. Ordering never removes candidates
   * (elimination happens in the per-route gates); it only decides where the
   * chain starts / how it is ranked.
   */
  private resolveChain(req: ChatRequest, op: RouteOp, task?: string): NormalizedRoute[] {
    const index = this.config.routes.findIndex((r) => r.id === req.model);
    if (index === -1) {
      const known = this.config.routes.map((r) => r.id).join(", ");
      throw new ConfigError(`unknown model "${req.model}" (known route ids: ${known})`);
    }
    const chain = this.config.routes.slice(index).map(normalizeRoute);
    const strategy = this.config.strategy;
    if (strategy === "round-robin" && chain.length > 1) {
      const offset = this.rrCounter++ % chain.length;
      if (offset > 0) chain.push(...chain.splice(0, offset));
    } else if (strategy === "weighted" && chain.length > 1) {
      // Weighted-random start, then fallback order from there.
      const weights = chain.map((r) => (r.weight && r.weight > 0 ? r.weight : 1));
      const total = weights.reduce((a, b) => a + b, 0);
      let pick = this.rng() * total;
      let offset = 0;
      for (let i = 0; i < weights.length; i++) {
        pick -= weights[i]!;
        if (pick <= 0) {
          offset = i;
          break;
        }
      }
      if (offset > 0) chain.push(...chain.splice(0, offset));
    } else if (strategy === "least-latency" && chain.length > 1) {
      // Fastest-first by observed EMA. Unobserved routes sort BEFORE observed
      // ones (bounded exploration: every route gets sampled once) and keep
      // their original relative order among themselves.
      const withIdx = chain.map((route, i) => ({
        route,
        i,
        ema: this.latencyEma.get(route.id),
      }));
      withIdx.sort((a, b) => {
        if (a.ema !== undefined && b.ema !== undefined) return a.ema - b.ema;
        if (a.ema === undefined && b.ema !== undefined) return -1;
        if (b.ema === undefined && a.ema !== undefined) return 1;
        return a.i - b.i;
      });
      for (let i = 0; i < withIdx.length; i++) chain[i] = withIdx[i]!.route;
    } else if (
      (strategy === "cheapest" || strategy === "balanced" || strategy === "quality-first") &&
      chain.length > 1
    ) {
      const order = this.policyOrder(chain, req, strategy, task);
      for (let i = 0; i < order.length; i++) chain[i] = order[i]!;
    }
    return chain;
  }

  /** Cost/quality-aware ordering for cheapest/balanced/quality-first. */
  private policyOrder(
    chain: NormalizedRoute[],
    req: ChatRequest,
    strategy: RoutingStrategy,
    task?: string,
  ): NormalizedRoute[] {
    const inputTokens = estimateTokens(req);
    const estCosts = chain.map((route) => {
      const price = priceLookup(this.pricing, route.id, route.model);
      return price ? estimateCostUsd(price, inputTokens, req.max_tokens) : undefined;
    });
    const healthSnapshots = this.health.snapshot();
    const latencies = chain.map((route) =>
      medianLatencyOf(healthSnapshots, route.id) ?? this.latencyEma.get(route.id),
    );
    const successRates = chain.map((route) => successRateOf(healthSnapshots, route.id));

    if (strategy === "cheapest") {
      // Priced candidates by ascending estimate; unpriced follow in config order.
      const idx = chain.map((_, i) => i);
      idx.sort((a, b) => {
        const ca = estCosts[a];
        const cb = estCosts[b];
        if (ca !== undefined && cb !== undefined) return ca - cb;
        if (ca !== undefined) return -1;
        if (cb !== undefined) return 1;
        return a - b;
      });
      return idx.map((i) => chain[i]!);
    }

    const qualities =
      strategy === "balanced"
        ? chain.map(() => undefined)
        : chain.map((route) => this.outcomes.quality(task, route.id));
    const scores = balancedScores({ estCosts, latencies, successRates, qualities });
    return orderByScore(scores).map((i) => chain[i]!);
  }

  /** Exponential-moving-average success latency per route (alpha 0.3). */
  private recordLatency(routeId: string, ms: number): void {
    const prev = this.latencyEma.get(routeId);
    this.latencyEma.set(routeId, prev === undefined ? ms : 0.3 * ms + 0.7 * prev);
  }

  /**
   * Pre-flight gating. rpm consumes 1 request via take(). tpm is a READ-ONLY
   * check: actual tokens are recorded post-hoc from provider usage reports,
   * so reserving an estimate pre-flight would double-count once the actuals
   * land in the same window (the reservation can't be reconciled away in a
   * sliding-window log). Stores without read-back fail open, like budgets.
   */
  private async takeBudget(route: NormalizedRoute): Promise<boolean> {
    if (
      route.limits.tpm !== undefined &&
      (await this.windowTotal(`${route.id}:tpm`, WINDOW_MS)) >= route.limits.tpm
    ) {
      return false;
    }
    if (route.limits.rpm !== undefined) {
      const decision = await this.store.take(`${route.id}:rpm`, 1, WINDOW_MS, route.limits.rpm);
      if (!decision.allowed) return false;
    }
    return true;
  }

  /** Read-only window total; errors and missing read-back fail open. */
  private async windowTotal(key: string, windowMs: number): Promise<number> {
    if (!this.store.used) return 0;
    try {
      return await this.store.used(key, windowMs);
    } catch {
      return 0;
    }
  }

  /**
   * True when the route's rolling USD spend budget is exhausted. Requires a
   * store that supports read-back (`used`); otherwise fails open. Spend is
   * recorded in micro-dollars, so the configured limit scales by 1e6 here.
   */
  private async budgetExhausted(route: NormalizedRoute): Promise<boolean> {
    if (!route.budget || !this.store.used) return false;
    const used = await this.windowTotal(`${route.id}:usd`, route.budget.windowMs ?? WINDOW_MS);
    return used >= Math.round(route.budget.usd * 1e6);
  }

  private async fireBeforeRequest(route: NormalizedRoute, req: ChatRequest, attempt: number): Promise<void> {
    if (!this.middleware?.beforeRequest) return;
    await this.middleware.beforeRequest({
      routeId: route.id,
      provider: route.provider,
      model: route.model,
      request: req,
      attempt,
    });
  }

  private async fireAfterResponse(route: NormalizedRoute, req: ChatRequest, attempt: number, response: ChatResponse): Promise<void> {
    if (!this.middleware?.afterResponse) return;
    await this.middleware.afterResponse({
      routeId: route.id,
      provider: route.provider,
      model: route.model,
      request: req,
      attempt,
    }, response);
  }

  private cbRecordSuccess(routeId: string): void {
    this.cbState.delete(routeId);
  }

  private cbRecordFailure(routeId: string): void {
    const now = Date.now();
    const state = this.cbState.get(routeId);
    if (state && now >= state.openUntil) {
      // Cooldown expired, reset the consecutive-failure count; the breach
      // count survives so graduated cooldowns keep escalating.
      state.failures = 1;
      state.openUntil = 0;
    } else if (state) {
      state.failures++;
    } else {
      this.cbState.set(routeId, { failures: 1, openUntil: 0, opens: 0 });
    }
    const s = this.cbState.get(routeId)!;
    if (s.failures >= this.cbThreshold && s.openUntil === 0) {
      s.opens++;
      s.openUntil = now + Math.min(this.cbCooldownMs * 2 ** (s.opens - 1), this.cbMaxCooldownMs);
    }
  }

  private cbIsOpen(routeId: string): boolean {
    const state = this.cbState.get(routeId);
    if (!state) return false;
    return Date.now() < state.openUntil;
  }

  private nextKeyIndex(route: NormalizedRoute): number {
    const cursor = this.keyCursor.get(route.id) ?? 0;
    this.keyCursor.set(route.id, cursor + 1);
    return cursor;
  }

  private priceFor(route: NormalizedRoute): TokenPrice | undefined {
    return this.pricing?.[route.id] ?? this.pricing?.[route.model];
  }

  /** Exponential backoff with jitter; a server Retry-After raises the floor. */
  private backoffMs(tryNumber: number, retryAfterMs?: number): number {
    const base = Math.min(BACKOFF_BASE_MS * 2 ** (tryNumber - 1), BACKOFF_CAP_MS);
    const jitter = this.rng() * BACKOFF_JITTER * base;
    return Math.max(retryAfterMs ?? 0, base) + jitter;
  }
}

function normalizeRoute(route: ModelRoute): NormalizedRoute {
  const keyPool = [
    ...(route.apiKey ? [route.apiKey] : []),
    ...(route.apiKeys ?? []),
  ];
  // Keyless routes are valid only for no-auth presets (ollama, vLLM, ...);
  // a placeholder keeps the rotation cursor arithmetic safe.
  if (keyPool.length === 0) keyPool.push("");

  // Preset expansion: `provider: "groq"` resolves to its wire-family
  // adapter + published baseUrl/auth without any per-route configuration.
  const preset = getPreset(route.provider);
  const adapterId = isSupported(route.provider) ? route.provider : preset?.adapter;

  return {
    ...route,
    adapterId,
    authHeaderName:
      preset && typeof preset.auth === "object" ? preset.auth.header : undefined,
    baseUrl: route.baseUrl ?? preset?.baseUrl,
    headers: { ...(preset?.headers ?? {}), ...(route.headers ?? {}) },
    keyPool,
    maxRetries: route.maxRetries ?? DEFAULT_MAX_RETRIES,
    timeoutMs: route.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    limits: { rpm: route.limit?.rpm, tpm: route.limit?.tpm },
  };
}

/**
 * Public heuristic token estimate (~3.5 chars/token, tighter than the 4-char
 * rule to avoid undercounting on code/JSON + per-message overhead). Exported
 * for callers building their own pre-flight gating; the engine's tpm
 * accounting is post-hoc from provider usage reports and no longer consumes
 * estimates.
 */
export function estimateTokens(req: Pick<ChatRequest, "messages" | "tools">): number {
  let chars = 0;
  for (const msg of req.messages) {
    chars += 4; // role + separators
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text") chars += part.text.length;
        else chars += 1000; // fixed allowance per image
      }
    }
    for (const tc of msg.tool_calls ?? []) {
      chars += tc.function.name.length + tc.function.arguments.length + 20;
    }
  }
  if (req.tools) {
    for (const tool of req.tools) {
      chars += tool.function.name.length + (tool.function.description?.length ?? 0) + 100;
    }
  }
  return Math.ceil(chars / 3.5) + 1;
}

function toProviderError(err: unknown, provider: string): ProviderError {  if (err instanceof ProviderError) return err;
  const wrapped = toNetworkError(provider, err);
  // Caller-cancellation aborts are returned unwrapped by toNetworkError;
  // reaching here means the abort raced past the signal check — propagate.
  if (wrapped instanceof ProviderError) return wrapped;
  throw wrapped;
}

function failedAttempt(
  route: NormalizedRoute,
  tries: number,
  keyIndex: number,
  last: ProviderError | undefined,
): AttemptRecord {
  return {
    routeId: route.id,
    provider: route.provider,
    model: route.model,
    outcome: "error",
    attempts: tries,
    keyIndex,
    kind: last?.kind,
    message: last ? last.message : undefined,
    ...(last?.retryAfterMs !== undefined ? { retryAfterMs: last.retryAfterMs } : {}),
  };
}

function emptyChunk(): ChatChunk {
  return { id: "", model: "", provider: "", delta: {}, finish_reason: null };
}

/** Total adapter tries: failed routes' tries plus the winning route's. */
function totalTries(attempts: AttemptRecord[], winningTries: number): number {
  return attempts.reduce((n, a) => n + a.attempts, 0) + winningTries;
}

/**
 * Stable FNV-1a hash for exact-match response cache keys. 32-bit: fine for
 * cache dedup of well-formed requests, but collisions serve a wrong cached
 * response — use a stronger hash (SHA-256) in the backing store's key if
 * adversarial key construction is possible.
 */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function responseCacheKey(req: ChatRequest): string {
  return `${req.model}:${fnv1a(JSON.stringify(req))}`;
}

/**
 * USD cost from token usage and per-1M-token pricing, rounded to 6 decimals.
 * Cache tiers apply when present; missing tiers fall back to the input price.
 */
export function computeCost(usage: Usage, price: TokenPrice): number {
  const cached = usage.cached_tokens ?? 0;
  const cacheWrite = usage.cache_write_tokens ?? 0;
  const uncached = Math.max(0, usage.prompt_tokens - cached - cacheWrite);
  const usd =
    (uncached / 1_000_000) * price.input +
    (cached / 1_000_000) * (price.cache_read ?? price.input) +
    (cacheWrite / 1_000_000) * (price.cache_write ?? price.input) +
    (usage.completion_tokens / 1_000_000) * price.output;
  return Math.round(usd * 1e6) / 1e6;
}

function abortFrom(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/** Classified kind for settlement summaries; deadlines report as timeouts. */
function failureKind(err: unknown): ErrorKind | undefined {
  if (err instanceof ProviderError) return err.kind;
  if (err instanceof DeadlineExceededError) return "timeout";
  return undefined;
}

/**
 * Iterator wrapper that releases an attempt's abort-link when the stream
 * ends — normally, on error, or when the caller abandons it (break/return).
 * Also propagates close() to the upstream iterator.
 */
async function* disposeOnEnd<T>(
  inner: AsyncIterator<T>,
  dispose: () => void,
): AsyncGenerator<T> {
  try {
    for (;;) {
      const result = await inner.next();
      if (result.done) {
        dispose();
        return result.value;
      }
      yield result.value;
    }
  } finally {
    dispose();
  }
}
