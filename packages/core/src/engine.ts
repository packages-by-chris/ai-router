/**
 * Routing engine: walks the fallback chain, enforces rate limits, rotates
 * keys, retries with backoff, and owns the streaming commit boundary
 * (fallback is only possible before the first chunk reaches the caller).
 *
 * Failure recovery layers, in order:
 *   1. retry same route+key (retryable kinds, backoff honoring Retry-After)
 *   2. rotate key on same route (rate_limit / auth / permission)
 *   3. next route in the chain
 */

import type { ModelRoute, RouterConfig } from "./config/schema.js";
import {
  AllRoutesFailedError,
  ConfigError,
  ProviderError,
  RateLimitedError,
  isKeyRelatedKind,
  isRetryableKind,
} from "./errors.js";
import type { AttemptRecord, ErrorKind } from "./errors.js";
import { MemoryStore } from "./limiter/memory.js";
import type { RateLimitStore } from "./limiter/store.js";
import { errorMessage, toNetworkError, type FetchLike } from "./http/request.js";
import { getAdapter } from "./providers/registry.js";
import type {
  AdapterContext,
  NormalizedRoute,
  ProviderAdapter,
  RawRequestOptions,
} from "./providers/types.js";
import type { ChatChunk, ChatRequest, ChatResponse } from "./types.js";

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 30_000;
const WINDOW_MS = 60_000;
const BACKOFF_BASE_MS = 400;
const BACKOFF_CAP_MS = 8_000;
const BACKOFF_JITTER = 0.25;

/** What happened at each step of routing a single request. */
export type AttemptOutcome = "ok" | "error" | "retry" | "skipped_rate_limit" | "unsupported";

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
}

/** Per-call options (second argument of complete/stream). */
export interface CallOptions {
  /** Observability hook: fired for every routing decision and retry. */
  onAttempt?: (event: AttemptEvent) => void;
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
}

export class RoutingEngine {
  private readonly store: RateLimitStore;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rng: () => number;
  /** Round-robin cursor so successive requests start on different keys. */
  private readonly keyCursor = new Map<string, number>();

  constructor(readonly config: RouterConfig, opts: EngineOptions = {}) {
    this.store = opts.store ?? new MemoryStore();
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.rng = opts.rng ?? Math.random;
  }

  async complete(req: ChatRequest, opts: CallOptions = {}): Promise<ChatResponse> {
    const notify = opts.onAttempt ?? noopNotify;
    const chain = this.resolveChain(req.model);
    const attempts: AttemptRecord[] = [];

    for (const route of chain) {
      let adapter: ProviderAdapter;
      try {
        adapter = getAdapter(route.provider);
      } catch (err) {
        const record = unsupportedAttempt(route, err);
        attempts.push(record);
        notify(record);
        continue;
      }

      if (!(await this.takeBudget(route, req))) {
        const record = skippedAttempt(route);
        attempts.push(record);
        notify(record);
        continue;
      }

      const result = await this.attemptRoute(adapter, route, req, notify);
      if (result.ok) {
        const usage = result.value.usage;
        if (route.limits.tpm !== undefined && usage) {
          await this.store.record(`${route.id}:tpm`, usage.total_tokens, WINDOW_MS);
        }
        return result.value;
      }
      attempts.push(result.attempt);
    }

    throw new AllRoutesFailedError(attempts);
  }

  /**
   * Returns a committed stream: the first chunk has already arrived, so the
   * route is final. Errors thrown mid-iteration happen after commit and
   * surface to the caller — a provider swap mid-stream is impossible.
   */
  async stream(req: ChatRequest, opts: CallOptions = {}): Promise<AsyncIterable<ChatChunk>> {
    const notify = opts.onAttempt ?? noopNotify;
    const chain = this.resolveChain(req.model);
    const attempts: AttemptRecord[] = [];

    for (const route of chain) {
      let adapter: ProviderAdapter;
      try {
        adapter = getAdapter(route.provider);
      } catch (err) {
        const record = unsupportedAttempt(route, err);
        attempts.push(record);
        notify(record);
        continue;
      }

      if (!(await this.takeBudget(route, req))) {
        const record = skippedAttempt(route);
        attempts.push(record);
        notify(record);
        continue;
      }

      const result = await this.attemptStreamRoute(adapter, route, req, notify);
      if (result.ok) return result.value;
      attempts.push(result.attempt);
    }

    throw new AllRoutesFailedError(attempts);
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
    const adapter = getAdapter(normalized.provider);

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
    return adapter.raw(normalized, key, opts, { fetchImpl: this.fetchImpl });
  }

  // ------------------------------------------------------------------ internals

  private resolveChain(model: string): NormalizedRoute[] {
    const index = this.config.routes.findIndex((r) => r.id === model);
    if (index === -1) {
      const known = this.config.routes.map((r) => r.id).join(", ");
      throw new ConfigError(`unknown model "${model}" (known route ids: ${known})`);
    }
    return this.config.routes.slice(index).map(normalizeRoute);
  }

  /** Pre-flight budget check. rpm costs 1 request; tpm costs an estimate. */
  private async takeBudget(route: NormalizedRoute, req: ChatRequest): Promise<boolean> {
    if (route.limits.rpm !== undefined) {
      const decision = await this.store.take(`${route.id}:rpm`, 1, WINDOW_MS, route.limits.rpm);
      if (!decision.allowed) return false;
    }
    if (route.limits.tpm !== undefined) {
      const decision = await this.store.take(
        `${route.id}:tpm`,
        estimateTokens(req),
        WINDOW_MS,
        route.limits.tpm,
      );
      if (!decision.allowed) return false;
    }
    return true;
  }

  private async attemptRoute(
    adapter: ProviderAdapter,
    route: NormalizedRoute,
    req: ChatRequest,
    notify: Notify,
  ): Promise<{ ok: true; value: ChatResponse } | { ok: false; attempt: AttemptRecord }> {
    const maxRetries = route.maxRetries;
    const poolSize = route.keyPool.length;
    let keyIndex = this.nextKeyIndex(route);
    let tries = 0;
    let retries = 0;
    let keysExhausted = 0;
    let last: ProviderError | undefined;

    for (;;) {
      const key = route.keyPool[keyIndex % poolSize] as string;
      tries++;
      try {
        const value = await adapter.complete(route, key, req, { fetchImpl: this.fetchImpl });
        notify({
          routeId: route.id, provider: route.provider, model: route.model,
          outcome: "ok", attempts: tries, keyIndex,
        });
        return { ok: true, value };
      } catch (err) {
        last = toProviderError(err, route.provider);
        // Rate limit / auth / permission: try the next key immediately.
        // If all keys exhausted (or only one key), fall back to next route.
        if (isKeyRelatedKind(last.kind)) {
          keysExhausted++;
          if (keysExhausted >= poolSize) break;
          const prevKeyIndex = keyIndex;
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
            outcome: "retry", attempts: tries, keyIndex,
            kind: last.kind, message: last.message,
          });
          await this.sleep(this.backoffMs(retries, last.retryAfterMs));
        } else {
          break;
        }
      }
    }

    const attempt = failedAttempt(route, tries, keyIndex, last);
    notify(attempt);
    return { ok: false, attempt };
  }

  private async attemptStreamRoute(
    adapter: ProviderAdapter,
    route: NormalizedRoute,
    req: ChatRequest,
    notify: Notify,
  ): Promise<{ ok: true; value: AsyncIterable<ChatChunk> } | { ok: false; attempt: AttemptRecord }> {
    const maxRetries = route.maxRetries;
    const poolSize = route.keyPool.length;
    let keyIndex = this.nextKeyIndex(route);
    let tries = 0;
    let retries = 0;
    let keysExhausted = 0;
    let last: ProviderError | undefined;

    for (;;) {
      const key = route.keyPool[keyIndex % poolSize] as string;
      tries++;
      try {
        const iterable = await adapter.stream(route, key, req, { fetchImpl: this.fetchImpl });
        const iterator = iterable[Symbol.asyncIterator]();
        const first = await iterator.next();
        if (first.done) {
          notify({
            routeId: route.id, provider: route.provider, model: route.model,
            outcome: "ok", attempts: tries, keyIndex,
          });
          return { ok: true, value: emptyStream() };
        }
        notify({
          routeId: route.id, provider: route.provider, model: route.model,
          outcome: "ok", attempts: tries, keyIndex,
        });
        return { ok: true, value: this.continueStream(route, first.value, iterator) };
      } catch (err) {
        last = toProviderError(err, route.provider);
        if (isKeyRelatedKind(last.kind)) {
          keysExhausted++;
          if (keysExhausted >= poolSize) break;
          const prevKeyIndex = keyIndex;
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
            outcome: "retry", attempts: tries, keyIndex,
            kind: last.kind, message: last.message,
          });
          await this.sleep(this.backoffMs(retries, last.retryAfterMs));
        } else {
          break;
        }
      }
    }

    const attempt = failedAttempt(route, tries, keyIndex, last);
    notify(attempt);
    return { ok: false, attempt };
  }

  private async *continueStream(
    route: NormalizedRoute,
    first: ChatChunk,
    iterator: AsyncIterator<ChatChunk>,
  ): AsyncGenerator<ChatChunk> {
    yield first;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      if (next.value.usage && route.limits.tpm !== undefined) {
        await this.store.record(`${route.id}:tpm`, next.value.usage.total_tokens, WINDOW_MS);
      }
      yield next.value;
    }
  }

  private nextKeyIndex(route: NormalizedRoute): number {
    const cursor = this.keyCursor.get(route.id) ?? 0;
    this.keyCursor.set(route.id, cursor + 1);
    return cursor;
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
  return {
    ...route,
    keyPool,
    headers: route.headers ?? {},
    maxRetries: route.maxRetries ?? DEFAULT_MAX_RETRIES,
    timeoutMs: route.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    limits: { rpm: route.limit?.rpm, tpm: route.limit?.tpm },
  };
}

/** Crude pre-hoc token estimate (~4 chars/token) used only for tpm gating. */
export function estimateTokens(req: ChatRequest): number {
  let chars = 0;
  for (const msg of req.messages) {
    chars += 4;
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text") chars += part.text.length;
        else chars += 1000; // fixed allowance per image
      }
    }
  }
  return Math.ceil(chars / 4) + 1;
}

function toProviderError(err: unknown, provider: string): ProviderError {
  if (err instanceof ProviderError) return err;
  return toNetworkError(provider, err);
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
  };
}

function skippedAttempt(route: NormalizedRoute): AttemptRecord {
  return {
    routeId: route.id,
    provider: route.provider,
    model: route.model,
    outcome: "skipped_rate_limit",
    attempts: 0,
  };
}

function unsupportedAttempt(route: NormalizedRoute, err: unknown): AttemptRecord {
  return {
    routeId: route.id,
    provider: route.provider,
    model: route.model,
    outcome: "unsupported",
    attempts: 0,
    message: errorMessage(err),
  };
}

function emptyStream(): AsyncIterable<ChatChunk> {
  return (async function* () {})();
}
