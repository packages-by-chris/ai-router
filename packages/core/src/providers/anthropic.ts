/**
 * Anthropic Messages API adapter.
 *
 * Wire format (verified against current docs):
 * - POST {base}/messages, headers x-api-key + anthropic-version
 * - `system` is top-level (extracted from unified system messages)
 * - `max_tokens` is REQUIRED (defaulted here)
 * - tool definitions use input_schema; results come back as user-turn
 *   tool_result blocks; calls arrive as tool_use content blocks
 * - SSE events are typed JSON payloads (message_start, content_block_delta,
 *   message_delta, message_stop, error) — dispatched on the `type` field
 * - stop_reason vocabulary differs; mapped to OpenAI-style finish_reason
 * - HTTP 529 (overloaded) classifies as retryable "server"
 */

import { ProviderError, classifyStatus, type ErrorKind } from "../errors.js";
import { requireOk, fetchWithTimeout, toNetworkError } from "../http/request.js";
import { sseData } from "../http/sse.js";
import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  Delta,
  ToolCall,
  Usage,
} from "../types.js";
import type { AdapterContext, NormalizedRoute, ProviderAdapter, RawRequestOptions } from "./types.js";

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
export const ANTHROPIC_VERSION = "2023-06-01";
/** Anthropic requires max_tokens; applied when the unified request omits it. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

function baseUrl(route: NormalizedRoute): string {
  return (route.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

interface AnthropicTurn {
  role: "user" | "assistant";
  blocks: Record<string, unknown>[];
}

/** data: URI or https(s) URL -> Anthropic image source block; null if unsupported. */
function imageBlock(url: string): Record<string, unknown> | null {
  const dataUri = /^data:([^;,]+);base64,(.*)$/i.exec(url);
  if (dataUri) {
    return {
      type: "image",
      source: { type: "base64", media_type: dataUri[1]!, data: dataUri[2]! },
    };
  }
  if (/^https?:\/\//i.test(url)) {
    return { type: "image", source: { type: "url", url } };
  }
  return null;
}

function pushUnifiedContent(
  push: (role: AnthropicTurn["role"], block: Record<string, unknown>) => void,
  role: AnthropicTurn["role"],
  content: ChatMessage["content"],
): void {
  if (typeof content === "string") {
    if (content.length > 0) push(role, { type: "text", text: content });
    return;
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === "text") {
        if (part.text.length > 0) push(role, { type: "text", text: part.text });
      } else if (part.type === "image_url") {
        // detail hint is OpenAI-only; dropped here
        const block = imageBlock(part.image_url.url);
        if (block) push(role, block);
      }
    }
  }
}

/**
 * Unified -> Anthropic body. Structural differences handled here:
 * system messages -> top-level `system`; role:"tool" -> user-turn
 * tool_result blocks; tool_calls -> tool_use blocks (arguments parsed);
 * consecutive same-role messages merged into one turn (Anthropic rejects
 * some non-alternating histories); stop -> stop_sequences.
 */
export function translateRequest(
  req: ChatRequest,
  providerModel: string,
  stream: boolean,
): Record<string, unknown> {
  const systemParts: string[] = [];
  const turns: AnthropicTurn[] = [];

  const push = (role: AnthropicTurn["role"], block: Record<string, unknown>) => {
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.blocks.push(block);
    else turns.push({ role, blocks: [block] });
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
      const resultText =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.filter((p) => p.type === "text").map((p) => p.text).join("\n")
            : "";
      push("user", {
        type: "tool_result",
        tool_use_id: msg.tool_call_id ?? "",
        content: resultText,
      });
      continue;
    }
    const role: AnthropicTurn["role"] = msg.role === "assistant" ? "assistant" : "user";
    pushUnifiedContent(push, role, msg.content);
    for (const tc of msg.tool_calls ?? []) {
      let input: unknown = {};
      try {
        input = JSON.parse(tc.function.arguments || "{}");
      } catch {
        input = {}; // malformed arguments degrade to an empty input object
      }
      push(role, { type: "tool_use", id: tc.id, name: tc.function.name, input });
    }
  }

  const body: Record<string, unknown> = {
    model: providerModel,
    max_tokens: req.max_tokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages: turns.map((t) => ({ role: t.role, content: t.blocks })),
  };
  if (systemParts.length > 0) body.system = systemParts.join("\n\n");
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.top_p !== undefined) body.top_p = req.top_p;
  if (req.stop !== undefined) body.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];

  const sendTools = req.tool_choice !== "none" && req.tools !== undefined && req.tools.length > 0;
  if (sendTools) {
    body.tools = req.tools!.map((t) => ({
      name: t.function.name,
      ...(t.function.description !== undefined ? { description: t.function.description } : {}),
      input_schema: t.function.parameters,
    }));
    const choice = req.tool_choice;
    if (choice === "auto") body.tool_choice = { type: "auto" };
    else if (choice === "required") body.tool_choice = { type: "any" };
    else if (typeof choice === "object") body.tool_choice = { type: "tool", name: choice.function.name };
  }

  if (stream) body.stream = true;
  return body;
}

/** Anthropic stop_reason -> OpenAI-style finish_reason. Unknown values pass through. */
export function mapFinishReason(stopReason: unknown): string | null {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      return typeof stopReason === "string" ? stopReason : null;
  }
}

function toUsage(v: unknown): Usage | null {
  if (typeof v !== "object" || v === null) return null;
  const u = v as Record<string, unknown>;
  const input = u.input_tokens;
  const output = u.output_tokens;
  if (typeof input !== "number" || typeof output !== "number") return null;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

/** Anthropic message -> unified ChatResponse. */
export function translateResponse(json: unknown, providerModel: string): ChatResponse {
  const j = json as Record<string, unknown>;
  const blocks = Array.isArray(j.content) ? (j.content as Record<string, unknown>[]) : [];

  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: typeof block.id === "string" ? block.id : "",
        type: "function",
        function: {
          name: typeof block.name === "string" ? block.name : "",
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  return {
    id: typeof j.id === "string" ? j.id : "",
    model: typeof j.model === "string" ? j.model : providerModel,
    provider: "anthropic",
    created: 0,
    usage: toUsage(j.usage),
    choices: [
      {
        index: 0,
        finish_reason: mapFinishReason(j.stop_reason),
        message: {
          role: "assistant",
          content: text !== "" ? text : toolCalls.length > 0 ? null : "",
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
  };
}

/** Anthropic stream `error` events -> ErrorKind (status-based mapping is done by requireOk). */
function classifyStreamErrorType(type: unknown): ErrorKind {
  switch (type) {
    case "invalid_request_error":
      return "invalid_request";
    case "authentication_error":
      return "auth";
    case "permission_error":
      return "permission";
    case "not_found_error":
      return "not_found";
    case "rate_limit_error":
      return "rate_limit";
    case "overloaded_error":
    case "api_error":
      return "server";
    default:
      return "unknown";
  }
}

function headers(route: NormalizedRoute, key: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": key,
    "anthropic-version": ANTHROPIC_VERSION,
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
  const url = `${baseUrl(route)}/messages`;
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
    throw toNetworkError("anthropic", err);
  }
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly id = "anthropic";

  /** Verbatim passthrough. No requireOk, no translation, no retries. */
  async raw(
    route: NormalizedRoute,
    key: string,
    opts: RawRequestOptions,
    ctx: AdapterContext,
  ): Promise<Response> {
    const url = `${baseUrl(route)}${opts.path ?? "/messages"}`;
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
      throw toNetworkError("anthropic", err);
    }
  }

  async complete(
    route: NormalizedRoute,
    key: string,
    req: ChatRequest,
    ctx: AdapterContext,
  ): Promise<ChatResponse> {
    const resp = await request(route, key, req, false, ctx);
    await requireOk(resp, "anthropic");
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
    await requireOk(resp, "anthropic");
    const body = resp.body;
    if (!body) throw new ProviderError("anthropic", "network", "anthropic: empty stream body");
    const model = route.model;

    return (async function* () {
      let id = "";
      let servedModel = model;
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      let finish: string | null = null;

      const chunk = (delta: Delta, extra: Partial<ChatChunk> = {}): ChatChunk => ({
        id,
        model: servedModel,
        provider: "anthropic",
        delta,
        finish_reason: null,
        ...extra,
      });

      for await (const data of sseData(body)) {
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }

        switch (ev.type) {
          case "message_start": {
            const message = (ev.message ?? {}) as Record<string, unknown>;
            if (typeof message.id === "string") id = message.id;
            if (typeof message.model === "string") servedModel = message.model;
            const usage = (message.usage ?? {}) as Record<string, unknown>;
            if (typeof usage.input_tokens === "number") inputTokens = usage.input_tokens;
            yield chunk({ role: "assistant" });
            break;
          }
          case "content_block_start": {
            const block = (ev.content_block ?? {}) as Record<string, unknown>;
            if (block.type === "tool_use") {
              yield chunk({
                tool_calls: [
                  {
                    index: typeof ev.index === "number" ? ev.index : 0,
                    id: typeof block.id === "string" ? block.id : "",
                    type: "function",
                    function: { name: typeof block.name === "string" ? block.name : "", arguments: "" },
                  },
                ],
              });
            }
            break;
          }
          case "content_block_delta": {
            const delta = (ev.delta ?? {}) as Record<string, unknown>;
            const index = typeof ev.index === "number" ? ev.index : 0;
            if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text !== "") {
              yield chunk({ content: delta.text });
            } else if (delta.type === "input_json_delta") {
              yield chunk({
                tool_calls: [
                  { index, function: { arguments: typeof delta.partial_json === "string" ? delta.partial_json : "" } },
                ],
              });
            }
            break;
          }
          case "message_delta": {
            const delta = (ev.delta ?? {}) as Record<string, unknown>;
            if (delta.stop_reason !== undefined) finish = mapFinishReason(delta.stop_reason);
            const usage = (ev.usage ?? {}) as Record<string, unknown>;
            if (typeof usage.output_tokens === "number") outputTokens = usage.output_tokens;
            break;
          }
          case "message_stop": {
            const usage =
              inputTokens !== null || outputTokens !== null
                ? {
                    prompt_tokens: inputTokens ?? 0,
                    completion_tokens: outputTokens ?? 0,
                    total_tokens: (inputTokens ?? 0) + (outputTokens ?? 0),
                  }
                : undefined;
            yield chunk({}, { finish_reason: finish, ...(usage ? { usage } : {}) });
            return;
          }
          case "error": {
            const err = (ev.error ?? {}) as Record<string, unknown>;
            throw new ProviderError(
              "anthropic",
              classifyStreamErrorType(err.type),
              `anthropic: ${typeof err.message === "string" ? err.message : "stream error"}`,
              { body: ev },
            );
          }
          default:
            break; // ping, content_block_stop
        }
      }
    })();
  }
}
