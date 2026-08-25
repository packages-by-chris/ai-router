/**
 * Deterministic provider simulator for failure-scenario tests.
 *
 * "Providers" are just hosts with a scripted per-call behavior. Behaviors are
 * pure functions of the call index, so scenarios are fully reproducible:
 *
 *   const sim = simulate({ a: healthy(), b: sequence(rateLimited(30), healthy()) });
 *   new RoutingEngine(cfg(["a", "b"]), { fetchImpl: sim.fetch })
 *
 * Simulated latency uses microtask ticks (never real sleeps) so tests stay
 * fast while still exercising async paths deterministically.
 */

import type { FetchLike } from "../src/http/request.js";
import { chunkJson, completionJson } from "./helpers.js";

export interface SimulatedCall {
  host: string;
  url: string;
  init: RequestInit | undefined;
}

/** One scripted provider behavior: given the 0-based call index, respond. */
export type Behavior = (call: number, init?: RequestInit) => Response | Promise<Response>;

export interface Simulation {
  fetch: FetchLike;
  /** Every simulated HTTP call in order. */
  calls: SimulatedCall[];
  /** Calls received per host. */
  countByHost(host: string): number;
  /** Abort controllers created per request (for hanging responses). */
  readonly signals: Array<AbortSignal | undefined>;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function ok(): Response {
  return json(completionJson());
}

// ---------------------------------------------------------------- behaviors

/** Always succeeds immediately. */
export function healthy(): Behavior {
  return () => ok();
}

/** Always 429 with an optional Retry-After (seconds). */
export function rateLimited(retryAfterSec?: number): Behavior {
  return () =>
    json(
      { error: { message: "rate limited" } },
      429,
      retryAfterSec !== undefined ? { "retry-after": String(retryAfterSec) } : {},
    );
}

/** Always 5xx-class server errors (retryable). */
export function serverError(status = 500): Behavior {
  return () => json({ error: { message: "upstream exploded" } }, status);
}

/** Auth/permission failures (key-related). */
export function authFailure(status: 401 | 403 = 401): Behavior {
  return () => json({ error: { message: "bad key" } }, status);
}

/** Non-retryable client errors. */
export function badRequest(status: 400 | 404 = 400): Behavior {
  return () => json({ error: { message: "invalid" } }, status);
}

/** Fails the first N calls, then succeeds. */
export function flaky(failures: number, inner: Behavior = serverError()): Behavior {
  return (call) => (call < failures ? inner(call) : ok());
}

/** Hangs until the caller's abort signal fires (timeout simulation). */
export function hangs(): Behavior {
  return (_call, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? undefined;
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException("aborted", "AbortError"));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => reject(signal.reason ?? new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
}

/** Responds after `ms` real ms (use sparingly; prefer hangs() + timeouts). */
export function slow(ms: number): Behavior {
  return async () => {
    await new Promise((r) => setTimeout(r, ms));
    return ok();
  };
}

/** SSE stream that yields `n` chunks then terminates cleanly. */
export function streamOk(n = 2): Behavior {
  return () => {
    const events = Array.from({ length: n }, (_, i) => chunkJson({ id: `c${i}` }));
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const e of events) controller.enqueue(encoder.encode(`data: ${e}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
}

/**
 * SSE stream whose FIRST chunk arrives, then the connection dies with an
 * error (post-commit stream failure).
 */
export function streamFailsMidway(): Behavior {
  return () => {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${chunkJson()}\n\n`));
        },
        pull(controller) {
          controller.error(new Error("connection reset by peer"));
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
}

/** HTTP-level failure BEFORE any stream data (pre-commit, fallback-eligible). */
export function streamStartsLate(): Behavior {
  return () =>
    new Response(
      new ReadableStream<Uint8Array>({ start() {} }), // never emits, never closes
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
}

/** Run behaviors[call] then settle to healthy(). */
export function sequence(...behaviors: Behavior[]): Behavior {
  return (call) => (call < behaviors.length ? behaviors[call]!(call) : healthy()(call));
}

// ------------------------------------------------------------------ runner

/**
 * Build a simulated multi-provider world. Keys are hostnames used in route
 * baseUrls (e.g. "a" -> https://a/v1).
 */
export function simulate(spec: Record<string, Behavior>): Simulation {
  const calls: SimulatedCall[] = [];
  const counts = new Map<string, number>();
  const signals: Array<AbortSignal | undefined> = [];
  const counters = new Map<string, number>();

  const fetch: FetchLike = async (url, init) => {
    const host = new URL(url).hostname.replace(/\.(test|local)$/, "");
    const behavior = spec[host];
    if (!behavior) throw new Error(`simulate: no behavior for host "${host}" (${url})`);
    calls.push({ host, url, init });
    counts.set(host, (counts.get(host) ?? 0) + 1);
    signals.push(init?.signal ?? undefined);
    const call = counters.get(host) ?? 0;
    counters.set(host, call + 1);
    await tick();
    return behavior(call, init);
  };

  return {
    fetch,
    calls,
    countByHost: (host) => counts.get(host) ?? 0,
    signals,
  };
}
