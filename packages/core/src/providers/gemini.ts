/**
 * Google Gemini generateContent adapter (v1beta REST).
 *
 * Wire format (verified against current docs):
 * - POST {base}/models/{model}:generateContent (streaming: :streamGenerateContent?alt=sse)
 * - auth via x-goog-api-key header
 * - roles are "user"/"model"; system prompt is top-level systemInstruction
 * - tool calls are functionCall parts; results go back as user-turn
 *   functionResponse parts whose `response` field MUST be a JSON object
 * - function declarations nest under tools[0].functionDeclarations;
 *   tool_choice maps to toolConfig.functionCallingConfig (AUTO/ANY/NONE)
 *   with allowedFunctionNames for named forcing
 * - sampling params live under generationConfig (maxOutputTokens, stopSequences)
 * - finishReason vocabulary differs; mapped to OpenAI-style finish_reason
 */

import { ProviderError, type ErrorKind } from "../errors.js";
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
  ToolCall,
  Usage,
} from "../types.js";
import type { AdapterContext, NormalizedRoute, ProviderAdapter, RawRequestOptions } from "./types.js";

export const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

function baseUrl(route: NormalizedRoute): string {
  return (route.baseUrl ?? GEMINI_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** Anthropic-style stop_reason map, Gemini edition. Unknown values pass through. */
export function mapFinishReason(finishReason: unknown): string | null {
  switch (finishReason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
      return "content_filter";
    default:
      return typeof finishReason === "string" ? finishReason : null;
  }
}

interface GeminiTurn {
  role: "user" | "model";
  parts: Record<string, unknown>[];
}

function guessImageMime(url: string): string {
  try {
    const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
    switch (ext) {
      case "png":
        return "image/png";
      case "webp":
        return "image/webp";
      case "gif":
        return "image/gif";
      default:
        return "image/jpeg"; // jpg/jpeg and unknown extensions
    }
  } catch {
    return "image/jpeg";
  }
}

/** data: URI or https(s) URL -> Gemini image part; null if unsupported. */
function imagePart(url: string): Record<string, unknown> | null {
  const dataUri = /^data:([^;,]+);base64,(.*)$/i.exec(url);
  if (dataUri) {
    return { inlineData: { mimeType: dataUri[1]!, data: dataUri[2]! } };
  }
  if (/^https?:\/\//i.test(url)) {
    // fileData requires a mimeType; guessed from the extension (documented limitation).
    return { fileData: { mimeType: guessImageMime(url), fileUri: url } };
  }
  return null;
}

function pushUnifiedContent(
  push: (role: GeminiTurn["role"], part: Record<string, unknown>) => void,
  role: GeminiTurn["role"],
  content: ChatMessage["content"],
): void {
  if (typeof content === "string") {
    if (content.length > 0) push(role, { text: content });
    return;
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === "text") {
        if (part.text.length > 0) push(role, { text: part.text });
      } else if (part.type === "image_url") {
        const image = imagePart(part.image_url.url);
        if (image) push(role, image);
      }
    }
  }
}

/**
 * Unified -> Gemini body. Structural differences handled here:
 * system messages -> top-level systemInstruction; assistant -> role "model";
 * tool_calls -> functionCall parts (arguments parsed); role:"tool" ->
 * user-turn functionResponse parts (function NAME resolved from the earlier
 * assistant tool_call by id, since Gemini identifies responses by name);
 * response_format json_object -> responseMimeType.
 */
export function translateRequest(
  req: ChatRequest,
  providerModel: string,
  stream: boolean,
): Record<string, unknown> {
  void stream; // streaming is selected by endpoint, not body flag

  const systemParts: string[] = [];
  const callNames = new Map<string, string>();
  for (const msg of req.messages) {
    for (const tc of msg.tool_calls ?? []) callNames.set(tc.id, tc.function.name);
  }

  const turns: GeminiTurn[] = [];
  const push = (role: GeminiTurn["role"], part: Record<string, unknown>) => {
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.parts.push(part);
    else turns.push({ role, parts: [part] });
  };

  for (const msg of req.messages) {
    if (msg.role === "system") {
      if (typeof msg.content === "string") {
        if (msg.content.length > 0) systemParts.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text" && part.text.length > 0) systemParts.push(part.text);
        }
      }
      continue;
    }
    if (msg.role === "tool") {
      const name = callNames.get(msg.tool_call_id ?? "") ?? msg.name ?? "";
      const id = msg.tool_call_id ?? "";
      const resultText =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.filter((p) => p.type === "text").map((p) => p.text).join("\n")
            : "";
      push("user", {
        functionResponse: {
          name,
          ...(id !== "" ? { id } : {}),
          response: { result: resultText },
        },
      });
      continue;
    }
    const role: GeminiTurn["role"] = msg.role === "assistant" ? "model" : "user";
    pushUnifiedContent(push, role, msg.content);
    for (const tc of msg.tool_calls ?? []) {
      let args: unknown = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        args = {}; // malformed arguments degrade to an empty args object
      }
      const id = tc.id;
      push(role, {
        functionCall: {
          name: tc.function.name,
          args,
          ...(id !== "" ? { id } : {}),
        },
      });
    }
  }

  const body: Record<string, unknown> = {
    contents: turns.map((t) => ({ role: t.role, parts: t.parts })),
  };
  if (systemParts.length > 0) {
    body.systemInstruction = { parts: systemParts.map((text) => ({ text })) };
  }

  const generationConfig: Record<string, unknown> = {};
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.top_p !== undefined) generationConfig.topP = req.top_p;
  if (req.max_tokens !== undefined) generationConfig.maxOutputTokens = req.max_tokens;
  if (req.stop !== undefined) {
    generationConfig.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  }
  if (req.response_format?.type === "json_object") {
    generationConfig.responseMimeType = "application/json";
  }
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

  const sendTools = req.tool_choice !== "none" && req.tools !== undefined && req.tools.length > 0;
  if (sendTools) {
    body.tools = [
      {
        functionDeclarations: req.tools!.map((t) => ({
          name: t.function.name,
          ...(t.function.description !== undefined ? { description: t.function.description } : {}),
          parameters: t.function.parameters,
        })),
      },
    ];
    const choice = req.tool_choice;
    if (choice === "auto") body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    else if (choice === "required") body.toolConfig = { functionCallingConfig: { mode: "ANY" } };
    else if (typeof choice === "object") {
      body.toolConfig = {
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: [choice.function.name] },
      };
    }
  }

  return body;
}

function toUsage(v: unknown): Usage | null {
  if (typeof v !== "object" || v === null) return null;
  const u = v as Record<string, unknown>;
  const prompt = u.promptTokenCount;
  const completion = u.candidatesTokenCount;
  if (typeof prompt !== "number" || typeof completion !== "number") return null;
  const total = typeof u.totalTokenCount === "number" ? u.totalTokenCount : prompt + completion;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

function partsToUnified(parts: Record<string, unknown>[]): {
  text: string;
  toolCalls: ToolCall[];
} {
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const part of parts) {
    if (typeof part.text === "string") {
      text += part.text;
    } else if (typeof part.functionCall === "object" && part.functionCall !== null) {
      const fc = part.functionCall as Record<string, unknown>;
      const index = toolCalls.length;
      toolCalls.push({
        id: typeof fc.id === "string" && fc.id !== "" ? fc.id : `call_${index}`,
        type: "function",
        function: {
          name: typeof fc.name === "string" ? fc.name : "",
          arguments: JSON.stringify(fc.args ?? {}),
        },
      });
    }
  }
  return { text, toolCalls };
}

/** Gemini generateContent response -> unified ChatResponse. */
export function translateResponse(json: unknown, providerModel: string): ChatResponse {
  const j = json as Record<string, unknown>;
  const candidates = Array.isArray(j.candidates) ? (j.candidates as Record<string, unknown>[]) : [];
  const candidate = candidates[0];
  const blocked =
    typeof (j.promptFeedback as Record<string, unknown> | undefined)?.blockReason === "string";

  let text = "";
  let toolCalls: ToolCall[] = [];
  let finish: string | null = null;
  if (candidate) {
    const content = (candidate.content ?? {}) as Record<string, unknown>;
    const parts = Array.isArray(content.parts) ? (content.parts as Record<string, unknown>[]) : [];
    const unified = partsToUnified(parts);
    text = unified.text;
    toolCalls = unified.toolCalls;
    finish = mapFinishReason(candidate.finishReason);
  } else if (blocked) {
    // Prompt blocked: HTTP 200, no candidates, promptFeedback.blockReason set.
    finish = "content_filter";
  }

  return {
    id: typeof j.responseId === "string" ? j.responseId : "",
    model: typeof j.modelVersion === "string" ? j.modelVersion : providerModel,
    provider: "gemini",
    created: 0,
    usage: toUsage(j.usageMetadata),
    choices: [
      {
        index: 0,
        finish_reason: finish,
        message: {
          role: "assistant",
          content: text !== "" ? text : toolCalls.length > 0 ? null : "",
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
  };
}

function headers(route: NormalizedRoute, key: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-goog-api-key": key,
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
  const method = stream ? ":streamGenerateContent?alt=sse" : ":generateContent";
  const url = `${baseUrl(route)}/models/${encodeURIComponent(route.model)}${method}`;
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
    throw toNetworkError("gemini", err);
  }
}

/** Gemini stream payloads can carry terminal errors; map their status strings. */
function classifyStreamError(status: unknown): ErrorKind {
  switch (status) {
    case "INVALID_ARGUMENT":
      return "invalid_request";
    case "UNAUTHENTICATED":
      return "auth";
    case "PERMISSION_DENIED":
      return "permission";
    case "NOT_FOUND":
      return "not_found";
    case "RESOURCE_EXHAUSTED":
      return "rate_limit";
    case "INTERNAL":
    case "UNAVAILABLE":
      return "server";
    default:
      return "unknown";
  }
}

export class GeminiAdapter implements ProviderAdapter {
  readonly id = "gemini";

  /** Verbatim passthrough. No requireOk, no translation, no retries. */
  async raw(
    route: NormalizedRoute,
    key: string,
    opts: RawRequestOptions,
    ctx: AdapterContext,
  ): Promise<Response> {
    const defaultPath = `/models/${encodeURIComponent(route.model)}:generateContent`;
    const url = `${baseUrl(route)}${opts.path ?? defaultPath}`;
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
      throw toNetworkError("gemini", err);
    }
  }

  async complete(
    route: NormalizedRoute,
    key: string,
    req: ChatRequest,
    ctx: AdapterContext,
  ): Promise<ChatResponse> {
    const resp = await request(route, key, req, false, ctx);
    await requireOk(resp, "gemini");
    const json = await resp.json();
    return translateResponse(json, route.model);
  }

  async stream(
    route: NormalizedRoute,
    key: string,
    req: ChatRequest,
    ctx: AdapterContext,
  ): Promise<AsyncIterable<ChatChunk>> {
    const resp = await request(route, key, req, true, ctx);
    await requireOk(resp, "gemini");
    const body = resp.body;
    if (!body) throw new ProviderError("gemini", "network", "gemini: empty stream body");
    const model = route.model;

    return (async function* () {
      let servedModel = model;
      let roleSent = false;
      let finish: string | null = null;
      let usage: Usage | null = null;

      const ensureRole = function* (): Generator<ChatChunk> {
        if (!roleSent) {
          roleSent = true;
          yield { id: "", model: servedModel, provider: "gemini", delta: { role: "assistant" }, finish_reason: null };
        }
      };

      for await (const data of sseData(body)) {
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (typeof ev.error === "object" && ev.error !== null) {
          const err = ev.error as Record<string, unknown>;
          throw new ProviderError(
            "gemini",
            classifyStreamError(err.status),
            `gemini: ${typeof err.message === "string" ? err.message : "stream error"}`,
            { body: ev },
          );
        }

        const candidate = Array.isArray(ev.candidates)
          ? (ev.candidates as Record<string, unknown>[])[0]
          : undefined;
        if (candidate) {
          const content = (candidate.content ?? {}) as Record<string, unknown>;
          const parts = Array.isArray(content.parts) ? (content.parts as Record<string, unknown>[]) : [];
          for (const part of parts) {
            if (typeof part.text === "string" && part.text !== "") {
              yield* ensureRole();
              const delta: Delta = { content: part.text };
              yield { id: "", model: servedModel, provider: "gemini", delta, finish_reason: null };
            } else if (typeof part.functionCall === "object" && part.functionCall !== null) {
              yield* ensureRole();
              const fc = part.functionCall as Record<string, unknown>;
              const delta: Delta = {
                tool_calls: [
                  {
                    index: 0,
                    ...(typeof fc.id === "string" && fc.id !== "" ? { id: fc.id } : {}),
                    type: "function",
                    function: {
                      name: typeof fc.name === "string" ? fc.name : "",
                      arguments: JSON.stringify(fc.args ?? {}),
                    },
                  },
                ],
              };
              yield { id: "", model: servedModel, provider: "gemini", delta, finish_reason: null };
            }
          }
          const mapped = mapFinishReason(candidate.finishReason);
          if (mapped !== null) finish = mapped;
        }

        const meta = toUsage(ev.usageMetadata);
        if (meta) usage = meta;
        if (typeof ev.modelVersion === "string") servedModel = ev.modelVersion;
      }

      if (finish !== null || usage !== null) {
        yield {
          id: "",
          model: servedModel,
          provider: "gemini",
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
    const url = `${baseUrl(route)}/models/${encodeURIComponent(route.model)}:batchEmbedContents`;
    const init: RequestInit = {
      method: "POST",
      headers: headers(route, key),
      body: JSON.stringify({
        requests: inputs.map((text) => ({
          model: `models/${route.model}`,
          content: { parts: [{ text }] },
        })),
      }),
    };
    let resp: Response;
    try {
      resp = await fetchWithTimeout(ctx.fetchImpl, url, init, {
        timeoutMs: route.timeoutMs,
        signal: ctx.signal,
      });
    } catch (err) {
      throw toNetworkError("gemini", err);
    }
    await requireOk(resp, "gemini");
    const j = (await resp.json()) as Record<string, unknown>;
    const raw = Array.isArray(j.embeddings) ? (j.embeddings as Record<string, unknown>[]) : [];
    const data: EmbeddingData[] = raw.map((d, i) => ({
      index: i,
      embedding: Array.isArray(d.values) ? (d.values as number[]) : [],
    }));
    return {
      object: "list",
      model: route.model,
      provider: "gemini",
      data,
      usage: toUsage(j.usageMetadata),
    };
  }
}
