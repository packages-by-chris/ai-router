/**
 * Error taxonomy. Classification drives the three distinct recovery layers:
 *
 *   1. retry same route+key      -> isRetryableKind
 *   2. rotate key on same route  -> isKeyRelatedKind
 *   3. fall back to next route   -> engine always does after a route exhausts
 */

export type ErrorKind =
  | "rate_limit"
  | "auth"
  | "permission"
  | "not_found"
  | "invalid_request"
  | "server"
  | "network"
  | "timeout"
  | "unknown";

export class AIRouterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ConfigError extends AIRouterError {}

export class UnsupportedProviderError extends AIRouterError {}

/** Thrown by the raw escape hatch when a route's rpm budget is exhausted. */
export class RateLimitedError extends AIRouterError {
  readonly routeId: string;
  readonly retryAfterMs: number;

  constructor(routeId: string, retryAfterMs: number) {
    super(`route "${routeId}" is rate-limited (retry after ${retryAfterMs}ms)`);
    this.routeId = routeId;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ProviderErrorOptions {
  status?: number;
  retryAfterMs?: number;
  body?: unknown;
  cause?: unknown;
}

export class ProviderError extends AIRouterError {
  readonly provider: string;
  readonly kind: ErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly body?: unknown;

  constructor(provider: string, kind: ErrorKind, message: string, opts: ProviderErrorOptions = {}) {
    super(message);
    this.provider = provider;
    this.kind = kind;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
    if (opts.body !== undefined) this.body = opts.body;
  }
}

export interface AttemptRecord {
  routeId: string;
  provider: string;
  model: string;
  outcome: "error" | "skipped_rate_limit" | "unsupported";
  attempts: number;
  keyIndex?: number;
  kind?: ErrorKind;
  message?: string;
}

export class AllRoutesFailedError extends AIRouterError {
  readonly attempts: AttemptRecord[];

  constructor(attempts: AttemptRecord[]) {
    super(`all routes failed (${attempts.length} attempted)`);
    this.attempts = attempts;
  }
}

export function classifyStatus(status: number): ErrorKind {
  if (status === 400) return "invalid_request";
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "unknown";
}

/** Whether the same route+key should be retried with backoff. */
export function isRetryableKind(kind: ErrorKind): boolean {
  return (
    kind === "rate_limit" || kind === "server" || kind === "network" || kind === "timeout"
  );
}

/** Whether a different API key on the same route could change the outcome. */
export function isKeyRelatedKind(kind: ErrorKind): boolean {
  return kind === "rate_limit" || kind === "auth" || kind === "permission";
}
