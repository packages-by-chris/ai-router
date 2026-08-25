/**
 * OpenAI adapter. Also serves every "openai-compatible" provider (Groq,
 * DeepSeek, Mistral, Together, Ollama, vLLM, OpenRouter...) via baseUrl.
 */

import { ProviderError } from "../errors.js";
import { requireOk, fetchWithTimeout, toNetworkError } from "../http/request.js";
import { sseData } from "../http/sse.js";
import type {
  ChatChunk,
  ChatMessage,
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

/**
 * Provider namespaces whose `providerOptions` entries this adapter merges
 * into the wire body. Later namespaces win on key conflicts.
 */
const OPENAI_OPTION_NAMESPACES = ["openai"] as const;

/** Shallow-merge providerOptions namespaces into the wire body. */
export function mergeProviderOptions(
  body: Record<string, unknown>,
  req: ChatRequest,
  namespaces: readonly string[],
): Record<string, unknown> {
  const opts = req.providerOptions;
  if (!opts) return body;
  for (const ns of namespaces) {
    const extra = opts[ns];
    if (extra && typeof extra === "object") Object.assign(body, extra);
  }
  return body;
}

/**
 * Wire-safe messages. Strips engine-only fields (providerOptions,
 * reasoning) that the unified ChatMessage carries but the OpenAI wire
 * protocol rejects ("Unrecognized request argument").
 */
export function wireMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.name !== undefined ? { name: m.name } : {}),
    ...(m.tool_calls !== undefined ? { tool_calls: m.tool_calls } : {}),
    ...(m.tool_call_id !== undefined ? { tool_call_id: m.tool_call_id } : {}),
  }));
}

export function translateRequest(req: ChatRequest, providerModel: string, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: providerModel,
    messages: wireMessages(req.messages),
  };
  if (req.tools !== undefined) body.tools = req.tools;
  if (req.tool_choice !== undefined) body.tool_choice = req.tool_choice;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.top_p !== undefined) body.top_p = req.top_p;
  if (req.max_tokens !== undefined) body.max_tokens = req.max_tokens;
  if (req.stop !== undefined) body.stop = req.stop;
  if (req.response_format !== undefined) body.response_format = req.response_format;
  if (req.reasoning_effort !== undefined) body.reasoning_effort = req.reasoning_effort;
  if (req.user !== undefined) body.user = req.user;
  if (stream) {
    body.stream = true;
    // Ask for a final usage-bearing chunk so post-hoc tpm accounting works.
    // providerOptions.openai.stream_options overrides the default; `null`
    // removes it (some strict OpenAI-compatible backends reject the field).
    const override = req.providerOptions?.openai?.stream_options;
    if (override === undefined) body.stream_options = { include_usage: true };
  }
  const merged = mergeProviderOptions(body, req, OPENAI_OPTION_NAMESPACES);
  // Null opt-out survives the namespace merge above — drop it so JSON null
  // never reaches the wire.
  if (merged.stream_options === null) delete merged.stream_options;
  return merged;
}

/** OpenAI usage details: cached prompt tokens + reasoning completion tokens. */
export function usageDetails(u: Record<string, unknown>): Partial<Usage> {
  const out: Partial<Usage> = {};
  const promptDetails = u.prompt_tokens_details as Record<string, unknown> | undefined;
  if (promptDetails && typeof promptDetails.cached_tokens === "number") {
    out.cached_tokens = promptDetails.cached_tokens;
  }
  const completionDetails = u.completion_tokens_details as Record<string, unknown> | undefined;
  if (completionDetails && typeof completionDetails.reasoning_tokens === "number") {
    out.reasoning_tokens = completionDetails.reasoning_tokens;
  }
  return out;
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
    ...usageDetails(u),
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
      // OpenAI-compatible reasoning deltas (OpenRouter "reasoning",
      // DeepSeek-style "reasoning_content", o-series "reasoning").
      ...(typeof d.reasoning === "string" && d.reasoning !== "" ? { reasoning: d.reasoning } : {}),
      ...(typeof d.reasoning_content === "string" && d.reasoning_content !== ""
        ? { reasoning: d.reasoning_content }
        : {}),
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
  readonly id: string = "openai";

  // Overridable wire-shape hooks. Azure reuses this entire adapter and only
  // changes the URL layout, auth header, and provider label.

  /** Provider label for unified responses/errors. */
  protected labelFor(route: NormalizedRoute): string {
    return providerLabel(route);
  }

  /** Base URL without trailing slashes. */
  protected base(route: NormalizedRoute): string {
    return baseUrl(route);
  }

  protected chatEndpoint(route: NormalizedRoute): string {
    return `${this.base(route)}/chat/completions`;
  }

  protected embedEndpoint(route: NormalizedRoute): string {
    return `${this.base(route)}/embeddings`;
  }

  protected rawEndpoint(route: NormalizedRoute, opts: RawRequestOptions): string {
    return `${this.base(route)}${opts.path ?? "/chat/completions"}`;
  }

  protected authHeaders(route: NormalizedRoute, key: string): Record<string, string> {
    // Presets may redirect the key into a named header (non-Bearer vendors).
    if (route.authHeaderName) return { [route.authHeaderName]: key };
    void route;
    return { authorization: `Bearer ${key}` };
  }

  /** providerOptions namespaces merged into request bodies (later wins). */
  protected optionNamespaces(): readonly string[] {
    return OPENAI_OPTION_NAMESPACES;
  }

  /**
   * Unified request -> wire body. Module-level translateRequest already
   * merges the "openai" namespace; subclasses extend the namespace list by
   * overriding optionNamespaces() and re-merging here.
   */
  protected buildBody(req: ChatRequest, providerModel: string, stream: boolean): Record<string, unknown> {
    const body = translateRequest(req, providerModel, stream);
    return mergeProviderOptions(body, req, this.optionNamespaces());
  }

  private async send(
    url: string,
    init: RequestInit,
    label: string,
    ctx: AdapterContext,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    try {
      return await fetchWithTimeout(ctx.fetchImpl, url, init, { timeoutMs, signal });
    } catch (err) {
      throw toNetworkError(label, err);
    }
  }

  /** Verbatim passthrough. No requireOk, no translation, no retries. */
  async raw(
    route: NormalizedRoute,
    key: string,
    opts: RawRequestOptions,
    ctx: AdapterContext,
  ): Promise<Response> {
    const label = this.labelFor(route);
    const init: RequestInit = {
      method: opts.method ?? "POST",
      headers: {
        "content-type": "application/json",
        ...this.authHeaders(route, key),
        ...route.headers,
        ...(opts.headers ?? {}),
      },
      ...(opts.body !== undefined
        ? { body: typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body) }
        : {}),
    };
    return this.send(this.rawEndpoint(route, opts), init, label, ctx, route.timeoutMs, opts.signal);
  }

  async complete(
    route: NormalizedRoute,
    key: string,
    req: ChatRequest,
    ctx: AdapterContext,
  ): Promise<ChatResponse> {
    const label = this.labelFor(route);
    const resp = await this.send(
      this.chatEndpoint(route),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.authHeaders(route, key),
          ...route.headers,
        },
        // buildBody merges this adapter's providerOptions namespaces.
        body: JSON.stringify(this.buildBody(req, route.model, false)),
      },
      label,
      ctx,
      route.timeoutMs,
      ctx.signal,
    );
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
    const label = this.labelFor(route);
    const resp = await this.send(
      this.chatEndpoint(route),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.authHeaders(route, key),
          ...route.headers,
        },
        body: JSON.stringify(this.buildBody(req, route.model, true)),
      },
      label,
      ctx,
      route.timeoutMs,
      ctx.signal,
    );
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
    const label = this.labelFor(route);
    const init: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.authHeaders(route, key),
        ...route.headers,
      },
      body: JSON.stringify({ model: route.model, input: req.input }),
    };
    const resp = await this.send(this.embedEndpoint(route), init, label, ctx, route.timeoutMs, ctx.signal);
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
