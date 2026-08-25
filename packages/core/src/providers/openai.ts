/**
 * OpenAI adapter. Also serves every "openai-compatible" provider (Groq,
 * DeepSeek, Mistral, Together, Ollama, vLLM, OpenRouter...) via baseUrl.
 */

import { ProviderError } from "../errors.js";
import { requireOk, fetchWithTimeout, toNetworkError } from "../http/request.js";
import { sseData } from "../http/sse.js";
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  Delta,
  EmbeddingData,
  EmbeddingRequest,
  EmbeddingResponse,
  Role,
  Usage,
} from "../types.js";
import type { AdapterContext, NormalizedRoute, ProviderAdapter, RawRequestOptions } from "./types.js";

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * Identity used in unified responses/errors. "openai-compatible" routes are
 * labeled by route id (the vendor is unknowable from the wire), known
 * providers by their provider id.
 */
export function providerLabel(route: NormalizedRoute): string {
  return route.provider === "openai-compatible" ? route.id : route.provider;
}

function baseUrl(route: NormalizedRoute): string {
  return (route.baseUrl ?? OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function translateRequest(req: ChatRequest, providerModel: string, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: providerModel,
    messages: req.messages,
  };
  if (req.tools !== undefined) body.tools = req.tools;
  if (req.tool_choice !== undefined) body.tool_choice = req.tool_choice;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.top_p !== undefined) body.top_p = req.top_p;
  if (req.max_tokens !== undefined) body.max_tokens = req.max_tokens;
  if (req.stop !== undefined) body.stop = req.stop;
  if (req.response_format !== undefined) body.response_format = req.response_format;
  if (req.user !== undefined) body.user = req.user;
  if (stream) {
    body.stream = true;
    // Ask for a final usage-bearing chunk so post-hoc tpm accounting works.
    body.stream_options = { include_usage: true };
  }
  return body;
}

function headers(route: NormalizedRoute, key: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${key}`,
    ...route.headers,
  };
}

async function request(
  route: NormalizedRoute,
  key: string,
  req: ChatRequest,
  stream: boolean,
  ctx: AdapterContext,
): Promise<Response> {
  const label = providerLabel(route);
  const url = `${baseUrl(route)}/chat/completions`;
  const init: RequestInit = {
    method: "POST",
    headers: headers(route, key),
    body: JSON.stringify(translateRequest(req, route.model, stream)),
  };
  try {
    return await fetchWithTimeout(ctx.fetchImpl, url, init, {
      timeoutMs: route.timeoutMs,
      signal: ctx.signal,
    });
  } catch (err) {
    throw toNetworkError(label, err);
  }
}

function toUsage(v: unknown): Usage | null {
  if (typeof v !== "object" || v === null) return null;
  const u = v as Record<string, unknown>;
  if (
    typeof u.prompt_tokens !== "number" ||
    typeof u.completion_tokens !== "number" ||
    typeof u.total_tokens !== "number"
  ) {
    return null;
  }
  return {
    prompt_tokens: u.prompt_tokens,
    completion_tokens: u.completion_tokens,
    total_tokens: u.total_tokens,
  };
}

function toRole(v: unknown): Role {
  return v === "system" || v === "user" || v === "assistant" || v === "tool" ? v : "assistant";
}

export function translateResponse(
  json: unknown,
  providerModel: string,
  providerLabel = "openai",
): ChatResponse {
  const j = json as Record<string, unknown>;
  const choicesRaw = Array.isArray(j.choices) ? j.choices : [];
  return {
    id: typeof j.id === "string" ? j.id : "",
    model: typeof j.model === "string" ? j.model : providerModel,
    provider: providerLabel,
    created: typeof j.created === "number" ? j.created : 0,
    usage: toUsage(j.usage),
    choices: choicesRaw.map((c, i) => {
      const ch = c as Record<string, unknown>;
      const msg = (ch.message ?? {}) as Record<string, unknown>;
      return {
        index: typeof ch.index === "number" ? ch.index : i,
        finish_reason: typeof ch.finish_reason === "string" ? ch.finish_reason : null,
        message: {
          role: toRole(msg.role),
          content: typeof msg.content === "string" ? msg.content : msg.content === null ? null : "",
          ...(msg.tool_calls !== undefined ? { tool_calls: msg.tool_calls as ChatResponse["choices"][number]["message"]["tool_calls"] } : {}),
          ...(msg.tool_call_id !== undefined ? { tool_call_id: msg.tool_call_id as string } : {}),
          ...(msg.name !== undefined ? { name: msg.name as string } : {}),
        },
      };
    }),
  };
}

export function translateChunk(
  json: unknown,
  providerModel: string,
  providerLabel = "openai",
): ChatChunk | null {
  const j = json as Record<string, unknown>;
  const choicesRaw = Array.isArray(j.choices) ? j.choices : [];
  const first = choicesRaw[0] as Record<string, unknown> | undefined;
  let delta: Delta = {};
  let finish_reason: string | null = null;
  if (first) {
    const d = (first.delta ?? {}) as Record<string, unknown>;
    delta = {
      ...(d.role !== undefined ? { role: toRole(d.role) } : {}),
      ...(d.content !== undefined ? { content: d.content as string } : {}),
      ...(d.tool_calls !== undefined ? { tool_calls: d.tool_calls as Delta["tool_calls"] } : {}),
    };
    if (typeof first.finish_reason === "string") finish_reason = first.finish_reason;
  }
  // Usage-only trailing chunk (choices empty) still carries usage.
  const usage = toUsage(j.usage);
  if (!first && !usage) return null;
  return {
    id: typeof j.id === "string" ? j.id : "",
    model: typeof j.model === "string" ? j.model : providerModel,
    provider: providerLabel,
    delta,
    finish_reason,
    ...(usage ? { usage } : {}),
  };
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly id = "openai";

  /** Verbatim passthrough. No requireOk, no translation, no retries. */
  async raw(
    route: NormalizedRoute,
    key: string,
    opts: RawRequestOptions,
    ctx: AdapterContext,
  ): Promise<Response> {
    const label = providerLabel(route);
    const url = `${baseUrl(route)}${opts.path ?? "/chat/completions"}`;
    const init: RequestInit = {
      method: opts.method ?? "POST",
      headers: { ...headers(route, key), ...(opts.headers ?? {}) },
      ...(opts.body !== undefined
        ? { body: typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body) }
        : {}),
    };
    try {
      return await fetchWithTimeout(ctx.fetchImpl, url, init, {
        timeoutMs: route.timeoutMs,
        signal: ctx.signal,
      });
    } catch (err) {
      throw toNetworkError(label, err);
    }
  }

  async complete(
    route: NormalizedRoute,
    key: string,
    req: ChatRequest,
    ctx: AdapterContext,
  ): Promise<ChatResponse> {
    const label = providerLabel(route);
    const resp = await request(route, key, req, false, ctx);
    await requireOk(resp, label);
    const json = await resp.json();
    return translateResponse(json, route.model, label);
  }

  async stream(
    route: NormalizedRoute,
    key: string,
    req: ChatRequest,
    ctx: AdapterContext,
  ): Promise<AsyncIterable<ChatChunk>> {
    const label = providerLabel(route);
    const resp = await request(route, key, req, true, ctx);
    await requireOk(resp, label);
    const body = resp.body;
    if (!body) throw new ProviderError(label, "network", `${label}: empty stream body`);
    const model = route.model;
    return (async function* () {
      for await (const data of sseData(body)) {
        if (data === "[DONE]") return;
        let json: unknown;
        try {
          json = JSON.parse(data);
        } catch {
          continue; // tolerate keep-alive noise
        }
        const chunk = translateChunk(json, model, label);
        if (chunk !== null) yield chunk;
      }
    })();
  }

  async embed(
    route: NormalizedRoute,
    key: string,
    req: EmbeddingRequest,
    ctx: AdapterContext,
  ): Promise<EmbeddingResponse> {
    const label = providerLabel(route);
    const url = `${baseUrl(route)}/embeddings`;
    const init: RequestInit = {
      method: "POST",
      headers: headers(route, key),
      body: JSON.stringify({ model: route.model, input: req.input }),
    };
    let resp: Response;
    try {
      resp = await fetchWithTimeout(ctx.fetchImpl, url, init, {
        timeoutMs: route.timeoutMs,
        signal: ctx.signal,
      });
    } catch (err) {
      throw toNetworkError(label, err);
    }
    await requireOk(resp, label);
    const j = (await resp.json()) as Record<string, unknown>;
    const raw = Array.isArray(j.data) ? (j.data as Record<string, unknown>[]) : [];
    const data: EmbeddingData[] = raw.map((d, i) => ({
      index: typeof d.index === "number" ? d.index : i,
      embedding: Array.isArray(d.embedding) ? (d.embedding as number[]) : [],
    }));
    return {
      object: "list",
      model: typeof j.model === "string" ? j.model : route.model,
      provider: label,
      data,
      usage: toUsage(j.usage),
    };
  }
}
