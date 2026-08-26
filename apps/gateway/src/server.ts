/**
 * OpenAI-compatible HTTP gateway in front of AIRouter.
 *
 * Endpoints:
 *   GET  /healthz              liveness
 *   GET  /v1/models            route ids as model entries
 *   POST /v1/chat/completions  complete() or SSE stream()
 *   POST /v1/embeddings        embed()
 *
 * The unified types are already OpenAI-shaped, so translation here is only
 * framing: chunks get wrapped in choices[], responses get `object` fields.
 * Zero dependencies beyond node:http.
 */

import {
  AllRoutesFailedError,
  AIRouter,
  ConfigError,
  DeadlineExceededError,
  GuardrailBlockedError,
  RateLimitedError,
  UnsupportedProviderError,
} from "@ai-router/core";
import type { AttemptEvent, RoutingOptions } from "@ai-router/core";
import type { ChatChunk, ChatRequest, EmbeddingRequest } from "@ai-router/core";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface GatewayOptions {
  router: AIRouter;
  /** Required Bearer key. When omitted the gateway refuses auth-less traffic only if allowNoAuth is false. */
  apiKey?: string;
  /** Skip auth entirely (dev only). cli.ts gates this behind GATEWAY_INSECURE=1. */
  allowNoAuth?: boolean;
  /** Request body cap. Default 10 MiB. */
  maxBodyBytes?: number;
}

const DEFAULT_BODY_CAP = 10 * 1024 * 1024;

// ------------------------------------------------------------------- helpers

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function errorBody(message: string, type: string, code?: string): unknown {
  return { error: { message, type, ...(code !== undefined ? { code } : {}) } };
}

/** Map engine errors to (status, extraHeaders). */
function errorStatus(err: unknown): { status: number; type: string; retryAfterSec?: number } {
  if (err instanceof RateLimitedError) {
    return { status: 429, type: "rate_limit_error", retryAfterSec: Math.ceil(err.retryAfterMs / 1000) };
  }
  if (err instanceof AllRoutesFailedError) {
    return {
      status: 502,
      type: "upstream_error",
      ...(err.retryAfterMs !== undefined
        ? { retryAfterSec: Math.ceil(err.retryAfterMs / 1000) }
        : {}),
    };
  }
  if (err instanceof DeadlineExceededError) return { status: 504, type: "timeout_error" };
  if (
    err instanceof ConfigError ||
    err instanceof UnsupportedProviderError ||
    err instanceof GuardrailBlockedError
  ) {
    return { status: 400, type: "invalid_request_error" };
  }
  const anyErr = err as { status?: number };
  if (typeof anyErr?.status === "number") {
    return { status: anyErr.status >= 400 ? anyErr.status : 502, type: "upstream_error" };
  }
  return { status: 500, type: "api_error" };
}

function sendError(res: ServerResponse, err: unknown): void {
  const { status, type, retryAfterSec } = errorStatus(err);
  const message = err instanceof Error ? err.message : String(err);
  json(res, status, errorBody(message, type), retryAfterSec !== undefined ? { "retry-after": String(retryAfterSec) } : {});
}

function readBody(req: IncomingMessage, cap: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > cap) {
        reject(new ConfigError(`request body exceeds ${cap} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Constant-time Bearer check; sha256 both sides so lengths never leak. */
function authorized(req: IncomingMessage, apiKey: string): boolean {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return false;
  const got = createHash("sha256").update(match[1]!, "utf8").digest();
  const want = createHash("sha256").update(apiKey, "utf8").digest();
  return timingSafeEqual(got, want);
}

function headerString(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Per-call routing constraints from x-routing-* request headers — the only
 * way OpenAI-protocol clients can express engine knobs. Absent/invalid
 * headers are ignored.
 */
function routingFromHeaders(req: IncomingMessage): RoutingOptions | undefined {
  const h = req.headers;
  const task = headerString(h["x-routing-task"]);
  const maxCostUsd = Number(headerString(h["x-routing-max-cost-usd"]));
  const maxLatencyMs = Number(headerString(h["x-routing-max-latency-ms"]));
  const requireTools = headerString(h["x-routing-require-tools"]) === "true";
  const routing: RoutingOptions = {
    ...(task !== undefined ? { task } : {}),
    ...(Number.isFinite(maxCostUsd) && maxCostUsd >= 0 ? { maxCostUsd } : {}),
    ...(Number.isFinite(maxLatencyMs) && maxLatencyMs > 0 ? { maxLatencyMs } : {}),
    ...(requireTools ? { require: { tools: true } } : {}),
  };
  return Object.keys(routing).length > 0 ? routing : undefined;
}

/** Aggregates AttemptEvents into the observability response headers. */
function makeAttemptTracker(): {
  onAttempt(event: AttemptEvent): void;
  routeHeaders(): Record<string, string>;
} {
  let attempts = 0;
  let routeId: string | undefined;
  let providerModel: string | undefined;
  return {
    onAttempt(event) {
      attempts += event.attempts;
      if (event.outcome === "ok") {
        routeId = event.routeId;
        providerModel = event.model;
      }
    },
    routeHeaders() {
      return {
        "x-ai-router-attempts": String(attempts),
        ...(routeId !== undefined ? { "x-ai-router-route": routeId } : {}),
        ...(providerModel !== undefined ? { "x-ai-router-model": providerModel } : {}),
      };
    },
  };
}

// ---------------------------------------------------- OpenAI response framing

function toOpenAIResponse(value: Awaited<ReturnType<AIRouter["complete"]>>): unknown {
  // ChatResponse is already OpenAI-shaped plus extras (provider, cost_usd);
  // clients ignore unknown fields — add the missing object discriminator.
  return { object: "chat.completion", ...value };
}

function chunkToOpenAI(chunk: ChatChunk, created: number): unknown {
  return {
    id: chunk.id,
    object: "chat.completion.chunk",
    created,
    model: chunk.model,
    choices: [{ index: 0, delta: chunk.delta, finish_reason: chunk.finish_reason }],
    ...(chunk.usage !== undefined ? { usage: chunk.usage } : {}),
    provider: chunk.provider,
    ...(chunk.cost_usd !== undefined ? { cost_usd: chunk.cost_usd } : {}),
  };
}

// -------------------------------------------------------------------- server

export function createGatewayServer(opts: GatewayOptions): Server {
  const { router } = opts;
  const bodyCap = opts.maxBodyBytes ?? DEFAULT_BODY_CAP;

  return createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) sendError(res, err);
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://gateway");
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /healthz") {
      json(res, 200, { ok: true });
      return;
    }

    // Auth gate for everything else.
    if (!opts.allowNoAuth) {
      if (opts.apiKey === undefined || !authorized(req, opts.apiKey)) {
        json(res, 401, errorBody("missing or invalid API key", "authentication_error"));
        return;
      }
    }

    if (route === "GET /v1/models" && req.method === "GET") {
      json(res, 200, {
        object: "list",
        data: router.routes.map((id) => ({ id, object: "model", owned_by: "ai-router" })),
      });
      return;
    }

    // Engine observability over HTTP (same Bearer key). Returns RouterStats.
    if (route === "GET /admin/stats") {
      json(res, 200, await router.stats());
      return;
    }

    if (route === "POST /v1/chat/completions") {
      await chat(req, res);
      return;
    }

    if (route === "POST /v1/embeddings") {
      await embeddings(req, res);
      return;
    }

    json(res, 404, errorBody(`no such endpoint: ${route}`, "invalid_request_error"));
  }

  async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: ChatRequest & { stream?: boolean };
    try {
      body = JSON.parse(await readBody(req, bodyCap)) as ChatRequest & { stream?: boolean };
    } catch (err) {
      json(res, 400, errorBody(`invalid JSON body: ${(err as Error).message}`, "invalid_request_error"));
      return;
    }
    if (typeof body?.model !== "string" || !Array.isArray(body?.messages)) {
      json(res, 400, errorBody('body must be a chat completion request with "model" and "messages"', "invalid_request_error"));
      return;
    }

    // Client disconnect aborts the in-flight call (and its upstream fetch).
    const abort = new AbortController();
    req.on("close", () => abort.abort(new DOMException("client disconnected", "AbortError")));
    const tracker = makeAttemptTracker();
    const routing = routingFromHeaders(req);
    const callOpts = {
      signal: abort.signal,
      onAttempt: tracker.onAttempt,
      ...(routing !== undefined ? { routing } : {}),
    };

    if (body.stream === true) {
      // All attempt events fire before commit, so the serving route and
      // total tries are known by the time headers go out.
      const stream = await router.stream(body, callOpts);
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        ...tracker.routeHeaders(),
      });
      const created = Math.floor(Date.now() / 1000);
      try {
        for await (const chunk of stream) {
          if (res.writableEnded) break;
          res.write(`data: ${JSON.stringify(chunkToOpenAI(chunk, created))}\n\n`);
        }
      } catch (err) {
        // Post-commit failure: best-effort error frame inside the stream.
        if (!res.writableEnded) {
          const message = err instanceof Error ? err.message : String(err);
          res.write(`data: ${JSON.stringify({ error: { message, type: "upstream_error" } })}\n\n`);
        }
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    try {
      const value = await router.complete(body, callOpts);
      json(res, 200, toOpenAIResponse(value), {
        ...tracker.routeHeaders(),
        ...(value.cost_usd !== undefined
          ? { "x-ai-router-cost-usd": String(value.cost_usd) }
          : {}),
      });
    } catch (err) {
      sendError(res, err);
    }
  }

  async function embeddings(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: EmbeddingRequest;
    try {
      body = JSON.parse(await readBody(req, bodyCap)) as EmbeddingRequest;
    } catch (err) {
      json(res, 400, errorBody(`invalid JSON body: ${(err as Error).message}`, "invalid_request_error"));
      return;
    }
    try {
      const abort = new AbortController();
      req.on("close", () => abort.abort());
      const value = await router.embed(body, { signal: abort.signal });
      json(res, 200, value);
    } catch (err) {
      sendError(res, err);
    }
  }
}
