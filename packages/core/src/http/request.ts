import { ProviderError, classifyStatus } from "../errors.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Streaming responses: keep the caller-abort relay attached after the
   * headers arrive so aborting mid-body still cancels the connection.
   * Without this flag the relay is detached as soon as fetch resolves
   * (right for one-shot JSON bodies; wrong for SSE streams).
   */
  streaming?: boolean;
}

/**
 * fetch with a per-attempt timeout and optional outer cancellation.
 * Network failures propagate as thrown errors; adapters wrap them into
 * ProviderError(kind: "network" | "timeout").
 */
export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  opts: FetchOptions,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("request timed out", "TimeoutError"));
  }, opts.timeoutMs);

  const onOuterAbort = () => controller.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) {
      clearTimeout(timer);
      throw new DOMException("aborted", "AbortError");
    }
    opts.signal.addEventListener("abort", onOuterAbort, { once: true });
  }

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    // For streams the relay stays attached for the body's lifetime; the
    // request's own completion/GC releases it.
    if (!opts.streaming && opts.signal) opts.signal.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * Wrap a low-level failure into a retryable ProviderError.
 * Caller-cancellation AbortErrors are returned unwrapped so the engine can
 * distinguish "user cancelled" (never retry, never fall back) from
 * transport failures. Timeout aborts keep the TimeoutError name.
 */
export function toNetworkError(provider: string, err: unknown): ProviderError | DOMException {
  if (err instanceof ProviderError) return err;
  if (err instanceof DOMException && err.name === "AbortError") return err;
  const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
  return new ProviderError(provider, isTimeout ? "timeout" : "network", errorMessage(err), {
    cause: err,
  });
}

/** True when the error is a caller-cancellation abort (never retryable). */
export function isAbortError(err: unknown): err is DOMException {
  return err instanceof DOMException && err.name === "AbortError";
}

/** Read Retry-After (seconds or HTTP-date) as milliseconds. */
export function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (raw === null || raw.length === 0) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Shared non-2xx handling. OpenAI and Anthropic error bodies both carry
 * { error: { message } }, so one implementation serves every adapter.
 */
export async function requireOk(resp: Response, provider: string): Promise<void> {
  if (resp.ok) return;
  const kind = classifyStatus(resp.status);
  let body: unknown;
  let message = `${provider}: HTTP ${resp.status}`;
  const text = await resp.text().catch(() => undefined);
  if (text !== undefined) {
    try {
      body = JSON.parse(text) as unknown;
      const errMsg = (body as { error?: { message?: string } }).error?.message;
      if (errMsg) message = `${provider}: ${errMsg}`;
    } catch {
      // non-JSON error body; keep the generic message
    }
  }
  throw new ProviderError(provider, kind, message, {
    status: resp.status,
    retryAfterMs: parseRetryAfter(resp.headers),
    body,
  });
}
