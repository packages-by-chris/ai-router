import type { ModelRoute } from "../config/schema.js";
import type { FetchLike } from "../http/request.js";
import type { ChatChunk, ChatRequest, ChatResponse } from "../types.js";

/** A validated route with defaults applied. Produced by the engine. */
export interface NormalizedRoute extends ModelRoute {
  keyPool: string[];
  headers: Record<string, string>;
  maxRetries: number;
  timeoutMs: number;
  limits: { rpm?: number; tpm?: number };
}

export interface AdapterContext {
  fetchImpl: FetchLike;
  signal?: AbortSignal;
}

/** Options for the raw escape hatch (`router.raw`). */
export interface RawRequestOptions {
  /** Path relative to the route's base URL. Defaults to the provider's chat endpoint. */
  path?: string;
  /** Request body. Objects are JSON-encoded; strings pass through verbatim. */
  body?: unknown;
  /** Extra headers merged over the adapter's auth/content-type defaults. */
  headers?: Record<string, string>;
  /** HTTP method. Default "POST". */
  method?: string;
}

/**
 * A provider adapter speaks one provider's wire protocol. Methods receive the
 * already-selected key so key rotation stays engine-owned.
 *
 * `stream` performs the HTTP request eagerly (so HTTP errors throw before any
 * chunk is consumed — the engine relies on that for pre-first-token fallback)
 * and returns an async iterable of unified chunks.
 *
 * `raw` sends the caller's body verbatim to the provider endpoint and returns
 * the undecorated Response — no translation, no retries, no fallback. It
 * exists for everything the unified layer does not model yet (multimodal,
 * thinking blocks, server tools, logprobs...).
 */
export interface ProviderAdapter {
  readonly id: string;
  complete(
    route: NormalizedRoute,
    key: string,
    req: ChatRequest,
    ctx: AdapterContext,
  ): Promise<ChatResponse>;
  stream(
    route: NormalizedRoute,
    key: string,
    req: ChatRequest,
    ctx: AdapterContext,
  ): Promise<AsyncIterable<ChatChunk>>;
  raw(
    route: NormalizedRoute,
    key: string,
    opts: RawRequestOptions,
    ctx: AdapterContext,
  ): Promise<Response>;
}
