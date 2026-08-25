/**
 * Google Vertex AI adapter (Gemini models on GCP).
 *
 * Wire format (verified against current docs):
 * - POST https://{region}-aiplatform.googleapis.com/v1/projects/{project}/
 *   locations/{region}/publishers/google/models/{model}:generateContent
 *   (streaming: :streamGenerateContent?alt=sse)
 * - Request/response bodies are IDENTICAL to the Gemini API — translation
 *   functions are imported from gemini.ts unchanged.
 * - Auth differs: OAuth2 bearer instead of x-goog-api-key. Route apiKey is
 *   EITHER a pre-obtained access token OR a full service-account JSON key
 *   (env-interpolate it: "apiKey": "${GCP_SA_KEY}"). SA keys are exchanged
 *   for tokens via the JWT bearer flow (RS256 over WebCrypto) and cached
 *   until shortly before expiry.
 * - Embeddings use :predict (instances/predictions shape), not batchEmbed.
 */

import { ConfigError, ProviderError } from "../errors.js";
import { requireOk, fetchWithTimeout, toNetworkError } from "../http/request.js";
import { sseData } from "../http/sse.js";
import {
  translateRequest as translateGeminiRequest,
  translateResponse as translateGeminiResponse,
} from "./gemini.js";
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  EmbeddingData,
  EmbeddingRequest,
  EmbeddingResponse,
} from "../types.js";
import type { AdapterContext, NormalizedRoute, ProviderAdapter, RawRequestOptions } from "./types.js";

const encoder = new TextEncoder();

export const VERTEX_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const VERTEX_TOKEN_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

function requireVertex(route: NormalizedRoute): { region: string; project: string; apiVersion: string } {
  if (!route.region || !route.project) {
    throw new ConfigError(`route "${route.id}": vertex provider requires region and project`);
  }
  return { region: route.region, project: route.project, apiVersion: route.apiVersion ?? "v1" };
}

function vertexUrl(route: NormalizedRoute, method: string): string {
  const { region, project, apiVersion } = requireVertex(route);
  return (
    `https://${region}-aiplatform.googleapis.com/${apiVersion}` +
    `/projects/${encodeURIComponent(project)}` +
    `/locations/${encodeURIComponent(region)}` +
    `/publishers/google/models/${encodeURIComponent(route.model)}:${method}`
  );
}

// ------------------------------------------------------ service account JWT

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

/** PEM "-----BEGIN PRIVATE KEY-----" -> DER bytes for importKey("pkcs8"). */
function pemToDer(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const raw = atob(b64);
  const der = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) der[i] = raw.charCodeAt(i);
  return der;
}

function b64url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signServiceAccountJwt(key: ServiceAccountKey): Promise<string> {
  if (!key.client_email || !key.private_key) {
    throw new ConfigError(
      'vertex: service account JSON must contain "client_email" and "private_key"',
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope: VERTEX_TOKEN_SCOPE,
      aud: VERTEX_TOKEN_ENDPOINT,
      iat: now,
      exp: now + 3600,
    }),
  );
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(key.private_key).slice().buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    encoder.encode(`${header}.${claims}`),
  );
  return `${header}.${claims}.${b64url(new Uint8Array(sig))}`;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();
const inflightExchanges = new Map<string, Promise<string>>();

/**
 * Resolve route apiKey -> bearer token. Non-JSON keys pass through as
 * pre-obtained access tokens; service-account JSON is exchanged and cached
 * until ~60s before expiry. Concurrent callers share one in-flight exchange.
 */
export async function resolveVertexToken(
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  let key: ServiceAccountKey;
  try {
    key = JSON.parse(apiKey) as ServiceAccountKey;
  } catch {
    return apiKey; // literal access token
  }
  if (typeof key.client_email !== "string" || typeof key.private_key !== "string") {
    return apiKey;
  }

  const cacheKey = `${key.client_email}:${key.private_key.length}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  const pending = inflightExchanges.get(cacheKey);
  if (pending) return pending;

  const exchange = (async (): Promise<string> => {
    const assertion = await signServiceAccountJwt(key);
    const resp = await fetchImpl(VERTEX_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    if (!resp.ok) {
      throw new ConfigError(`vertex: token exchange failed (${resp.status})`);
    }
    const j = (await resp.json()) as { access_token?: string; expires_in?: number };
    if (typeof j.access_token !== "string") {
      throw new ConfigError("vertex: token exchange returned no access_token");
    }
    const ttlMs = (typeof j.expires_in === "number" ? j.expires_in : 3600) * 1000 - 60_000;
    tokenCache.set(cacheKey, { token: j.access_token, expiresAt: Date.now() + ttlMs });
    return j.access_token;
  })();

  inflightExchanges.set(cacheKey, exchange);
  try {
    return await exchange;
  } finally {
    inflightExchanges.delete(cacheKey);
  }
}

/** Test hook: drop all cached OAuth tokens. */
export function clearVertexTokenCache(): void {
  tokenCache.clear();
  inflightExchanges.clear();
}

// ------------------------------------------------------------------ adapter

export class VertexAdapter implements ProviderAdapter {
  readonly id = "vertex";

  private async headers(
    route: NormalizedRoute,
    key: string,
    ctx: AdapterContext,
  ): Promise<Record<string, string>> {
    const token = await resolveVertexToken(key, ctx.fetchImpl as unknown as typeof fetch);
    return {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...route.headers,
    };
  }

  /** Verbatim passthrough. No requireOk, no translation, no retries. */
  async raw(
    route: NormalizedRoute,
    key: string,
    opts: RawRequestOptions,
    ctx: AdapterContext,
  ): Promise<Response> {
    // Default endpoint is generateContent; a custom path replaces the
    // ":method" suffix (leading ":" optional).
    const target =
      opts.path !== undefined
        ? vertexUrl(route, opts.path.replace(/^:/, ""))
        : vertexUrl(route, "generateContent");
    const init: RequestInit = {
      method: opts.method ?? "POST",
      headers: {
        ...(await this.headers(route, key, ctx)),
        ...(opts.headers ?? {}),
      },
      ...(opts.body !== undefined
        ? { body: typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body) }
        : {}),
    };
    try {
      return await fetchWithTimeout(ctx.fetchImpl, target, init, {
        timeoutMs: route.timeoutMs,
        signal: ctx.signal,
      });
    } catch (err) {
      throw toNetworkError("vertex", err);
    }
  }

  private async post(
    route: NormalizedRoute,
    key: string,
    method: "generateContent" | "streamGenerateContent" | "predict",
    body: unknown,
    ctx: AdapterContext,
    streaming = false,
  ): Promise<Response> {
    const init: RequestInit = {
      method: "POST",
      headers: await this.headers(route, key, ctx),
      body: JSON.stringify(body),
    };
    try {
      return await fetchWithTimeout(ctx.fetchImpl, vertexUrl(route, method), init, {
        timeoutMs: route.timeoutMs,
        signal: ctx.signal,
        streaming,
      });
    } catch (err) {
      throw toNetworkError("vertex", err);
    }
  }

  async complete(
    route: NormalizedRoute,
    key: string,
    req: ChatRequest,
    ctx: AdapterContext,
  ): Promise<ChatResponse> {
    const resp = await this.post(
      route, key, "generateContent",
      translateGeminiRequest(req, route.model, false),
      ctx,
    );
    await requireOk(resp, "vertex");
    const json = await resp.json();
    const translated = translateGeminiResponse(json, route.model);
    // Shared Gemini translator stamps its own label; this is a vertex call.
    return { ...translated, provider: "vertex" };
  }

  async stream(
    route: NormalizedRoute,
    key: string,
    req: ChatRequest,
    ctx: AdapterContext,
  ): Promise<AsyncIterable<ChatChunk>> {
    const resp = await this.post(
      route, key, "streamGenerateContent",
      translateGeminiRequest(req, route.model, true),
      ctx,
      true, // streaming: keep the abort relay attached for the body lifetime
    );
    await requireOk(resp, "vertex");
    const body = resp.body;
    if (!body) throw new ProviderError("vertex", "network", "vertex: empty stream body");

    // SSE payloads are Gemini generateContent shapes; reuse the shared
    // response translator per event, emitting deltas eagerly and buffering
    // terminal state (finish reason + usage) into one final chunk.
    return (async function* () {
      let roleSent = false;
      let finish: string | null = null;
      let usage: ChatChunk["usage"];
      let lastId = "";
      let lastModel = "";

      const ensureRole = function* (): Generator<ChatChunk> {
        if (!roleSent) {
          roleSent = true;
          yield { id: lastId, model: lastModel, provider: "vertex", delta: { role: "assistant" }, finish_reason: null };
        }
      };

      for await (const data of sseData(body)) {
        let ev: unknown;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        const partial = translateGeminiResponse(ev, "");
        const choice = partial.choices[0];
        if (!choice) continue;
        const message = choice.message;
        if (partial.id) lastId = partial.id;
        if (partial.model) lastModel = partial.model;

        if (typeof message.content === "string" && message.content !== "") {
          yield* ensureRole();
          yield {
            id: lastId,
            model: lastModel,
            provider: "vertex",
            delta: { content: message.content },
            finish_reason: null,
          };
        }
        if (message.reasoning) {
          yield* ensureRole();
          yield {
            id: lastId,
            model: lastModel,
            provider: "vertex",
            delta: { reasoning: message.reasoning },
            finish_reason: null,
          };
        }
        if (message.tool_calls?.length) {
          yield* ensureRole();
          yield {
            id: lastId,
            model: lastModel,
            provider: "vertex",
            delta: {
              tool_calls: message.tool_calls.map((tc, index) => ({
                index,
                ...(tc.id ? { id: tc.id } : {}),
                type: "function" as const,
                function: tc.function,
              })),
            },
            finish_reason: null,
          };
        }
        if (choice.finish_reason !== null) finish = choice.finish_reason;
        if (partial.usage) usage = partial.usage;
      }

      if (finish !== null || usage !== undefined) {
        yield {
          id: lastId,
          model: lastModel,
          provider: "vertex",
          delta: {},
          finish_reason: finish,
          ...(usage ? { usage } : {}),
        };
      }
    })();
  }

  async embed(
    route: NormalizedRoute,
    key: string,
    req: EmbeddingRequest,
    ctx: AdapterContext,
  ): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    const resp = await this.post(
      route, key, "predict",
      { instances: inputs.map((content) => ({ content })) },
      ctx,
    );
    await requireOk(resp, "vertex");
    const j = (await resp.json()) as Record<string, unknown>;
    const preds = Array.isArray(j.predictions) ? (j.predictions as Record<string, unknown>[]) : [];
    const data: EmbeddingData[] = preds.map((p, i) => {
      const emb = (p.embeddings ?? {}) as Record<string, unknown>;
      return {
        index: i,
        embedding: Array.isArray(emb.values) ? (emb.values as number[]) : [],
      };
    });
    return {
      object: "list",
      model: route.model,
      provider: "vertex",
      data,
      usage: null,
    };
  }
}
