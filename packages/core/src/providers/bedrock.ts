/**
 * AWS Bedrock adapter — Converse API.
 *
 * Wire format (verified against current docs):
 * - POST https://bedrock-runtime.{region}.amazonaws.com/model/{modelId}/converse
 *   (streaming: /converse-stream)
 * - Auth: AWS SigV4, hand-rolled over WebCrypto (zero runtime deps).
 *   Route apiKey format: "ACCESS_KEY_ID:SECRET_ACCESS_KEY[:SESSION_TOKEN]".
 * - Converse speaks one unified shape across ALL bedrock models (Claude,
 *   Llama, Mistral, Titan...), so no per-model payload families here.
 * - converse-stream returns the BINARY AWS event-stream framing (not SSE);
 *   parsed incrementally below. Message CRCs are trusted to the transport.
 * - Images: only base64 data URIs translate (converse has no remote-url
 *   image source); https image parts are dropped.
 *
 * Credentials never leave the signing layer; session tokens ride the
 * x-amz-security-token header.
 */

import { ConfigError, ProviderError } from "../errors.js";
import { requireOk, fetchWithTimeout, toNetworkError } from "../http/request.js";
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

const encoder = new TextEncoder();

// ------------------------------------------------------------------- sigv4

interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Route key format: "ACCESS_KEY_ID:SECRET_ACCESS_KEY[:SESSION_TOKEN]". */
function parseAwsCredentials(key: string): AwsCredentials {
  const parts = key.split(":");
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new ConfigError(
      'route: bedrock apiKey must be "ACCESS_KEY_ID:SECRET_ACCESS_KEY[:SESSION_TOKEN]"',
    );
  }
  return {
    accessKeyId: parts[0]!,
    secretAccessKey: parts[1]!,
    ...(parts[2] !== undefined && parts[2] !== "" ? { sessionToken: parts[2] } : {}),
  };
}

async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(
  key: Uint8Array<ArrayBuffer>,
  msg: string | Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = typeof msg === "string" ? encoder.encode(msg) : msg;
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, data);
  return new Uint8Array(sig);
}

/** ISO basic format: YYYYMMDDTHHMMSSZ */
function amzDate(now: Date): { amz: string; date: string } {
  const iso = now.toISOString();
  const amz = iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amz, date: amz.slice(0, 8) };
}

/**
 * Sign a fetch init with SigV4 and return mutated headers. Pure given inputs
 * (clock injected) so conformance can assert canonical forms.
 */
export async function sigv4Headers(opts: {
  method: string;
  url: string;
  body: Uint8Array<ArrayBuffer>;
  credentials: AwsCredentials;
  region: string;
  service?: string;
  now?: Date;
}): Promise<Record<string, string>> {
  const service = opts.service ?? "bedrock";
  const url = new URL(opts.url);
  const { amz, date } = amzDate(opts.now ?? new Date());

  // Canonical URI: path segments encoded, separators preserved.
  const uri = url.pathname.split("/").map(encodeURIComponent).join("/");
  const canonicalHeaders =
    `content-type:application/json\n` +
    `host:${url.host}\n` +
    `x-amz-date:${amz}\n` +
    (opts.credentials.sessionToken ? `x-amz-security-token:${opts.credentials.sessionToken}\n` : "");
  const signedHeaders =
    "content-type;host;x-amz-date" +
    (opts.credentials.sessionToken ? ";x-amz-security-token" : "");

  const payloadHash = await sha256Hex(opts.body);
  const canonicalRequest = [
    opts.method,
    uri,
    "", // no query params on converse endpoints
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${date}/${opts.region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amz,
    scope,
    await sha256Hex(encoder.encode(canonicalRequest)),
  ].join("\n");

  let signingKey = await hmac(encoder.encode(`AWS4${opts.credentials.secretAccessKey}`), date);
  signingKey = await hmac(signingKey, opts.region);
  signingKey = await hmac(signingKey, service);
  signingKey = await hmac(signingKey, "aws4_request");

  const signature = await hmac(signingKey, stringToSign);
  const signatureHex = [...signature].map((b) => b.toString(16).padStart(2, "0")).join("");

  return {
    "content-type": "application/json",
    "x-amz-date": amz,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${opts.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signatureHex}`,
    ...(opts.credentials.sessionToken ? { "x-amz-security-token": opts.credentials.sessionToken } : {}),
  };
}

// ------------------------------------------------- binary event-stream parse

export interface AwsEventStreamMessage {
  headers: Map<string, string>;
  /** Raw payload bytes (JSON for converse-stream events). */
  payload: Uint8Array;
}

/**
 * Incremental parser for the AWS event-stream binary framing:
 *   [prelude: total_len u32 | headers_len u32 | prelude_crc u32]
 *   [headers][payload][message_crc u32]
 * Yields decoded messages; tolerates arbitrary network chunk boundaries.
 * CRCs are skipped (transport integrity is TCP/TLS's job).
 */
export function awsEventStream(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
): AsyncGenerator<AwsEventStreamMessage> {
  return (async function* () {
    let buffer = new Uint8Array(0);
    const reader = body.getReader();

    const headerValueSize = (dv: DataView, type: number, at: number): number => {
      switch (type) {
        case 0: case 1: return 0; // true / false
        case 2: return 1; // byte
        case 3: return 2; // short
        case 4: return 4; // integer
        case 5: return 8; // long
        case 6: case 7: return 2 + dv.getUint16(at); // byte-array / string (u16 len)
        case 8: case 9: return 8; // timestamp / long variant
        case 10: return 2;
        case 11: return 4;
        case 12: return 8;
        case 13: {
          // varint
          let size = 0;
          let pos = at;
          for (;;) {
            const b = dv.getUint8(pos);
            size++;
            pos++;
            if ((b & 0x80) === 0) break;
          }
          return size;
        }
        default: return 0;
      }
    };

    const parseHeaders = (
      dv: DataView,
      start: number,
      end: number,
    ): Map<string, string> => {
      const headers = new Map<string, string>();
      let off = start;
      while (off < end) {
        const nameLen = dv.getUint8(off);
        off += 1;
        const name = new TextDecoder().decode(new Uint8Array(dv.buffer, dv.byteOffset + off, nameLen));
        off += nameLen;
        const type = dv.getUint8(off);
        off += 1;
        const valueSize = headerValueSize(dv, type, off);
        if (type === 7 || type === 6) {
          const strLen = dv.getUint16(off);
          const bytes = new Uint8Array(dv.buffer, dv.byteOffset + off + 2, strLen);
          headers.set(name, type === 7 ? new TextDecoder().decode(bytes) : `<binary:${strLen}>`);
        }
        off += valueSize;
      }
      return headers;
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        const merged = new Uint8Array(buffer.length + value.length);
        merged.set(buffer);
        merged.set(value, buffer.length);
        buffer = merged;

        // Drain all complete messages from the buffer.
        for (;;) {
          if (buffer.length < 12) break;
          const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
          const totalLen = dv.getUint32(0);
          if (buffer.length < totalLen) break;
          const headersLen = dv.getUint32(4);
          const headersEnd = 12 + headersLen;
          const payloadEnd = totalLen - 4; // trailing message CRC
          const headers = headersEnd <= payloadEnd
            ? parseHeaders(dv, 12, headersEnd)
            : new Map<string, string>();
          yield {
            headers,
            payload: buffer.slice(12 + headersLen, payloadEnd),
          };
          buffer = buffer.slice(totalLen);
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();
}

// -------------------------------------------------------- wire translation

function baseUrl(route: NormalizedRoute): string {
  if (route.baseUrl) return route.baseUrl.replace(/\/+$/, "");
  if (!route.region) {
    throw new ConfigError(`route "${route.id}": bedrock provider requires region`);
  }
  return `https://bedrock-runtime.${route.region}.amazonaws.com`;
}

/** Converse stopReason -> OpenAI-style finish_reason. Unknown passes through. */
export function mapBedrockStopReason(stopReason: unknown): string | null {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "content_filtered":
    case "guardrail_intervened":
      return "content_filter";
    default:
      return typeof stopReason === "string" ? stopReason : null;
  }
}

interface ConverseTurn {
  role: "user" | "assistant";
  blocks: Record<string, unknown>[];
}

const IMAGE_FORMATS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** data: URI -> converse image block. Remote https URLs are NOT supported. */
function imageBlock(url: string): Record<string, unknown> | null {
  const dataUri = /^data:([^;,]+);base64,(.*)$/i.exec(url);
  if (!dataUri) return null;
  const format = IMAGE_FORMATS[dataUri[1]!.toLowerCase()];
  if (!format) return null;
  return { image: { format, source: { bytes: dataUri[2]! } } };
}

function pushUnifiedContent(
  push: (role: ConverseTurn["role"], block: Record<string, unknown>) => void,
  role: ConverseTurn["role"],
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
        const block = imageBlock(part.image_url.url);
        if (block) push(role, block);
      }
    }
  }
}

/**
 * Unified -> Converse body. Structural differences handled here:
 * system -> top-level `system`; role:"tool" -> user-turn toolResult blocks;
 * tool_calls -> toolUse blocks (arguments parsed); sampling params live
 * under inferenceConfig; tools nest under toolConfig.toolSpec.
 */
export function translateRequest(
  req: ChatRequest,
  providerModel: string,
  stream: boolean,
): Record<string, unknown> {
  void stream; // streaming is selected by endpoint, not a body flag

  const systemParts: string[] = [];
  const turns: ConverseTurn[] = [];
  const push = (role: ConverseTurn["role"], block: Record<string, unknown>) => {
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
        toolResult: {
          toolUseId: msg.tool_call_id ?? "",
          content: [{ text: resultText }],
        },
      });
      continue;
    }
    const role: ConverseTurn["role"] = msg.role === "assistant" ? "assistant" : "user";
    pushUnifiedContent(push, role, msg.content);
    for (const tc of msg.tool_calls ?? []) {
      let input: unknown = {};
      try {
        input = JSON.parse(tc.function.arguments || "{}");
      } catch {
        input = {}; // malformed arguments degrade to an empty input object
      }
      push(role, { toolUse: { toolUseId: tc.id, name: tc.function.name, input } });
    }
  }

  const body: Record<string, unknown> = {
    messages: turns.map((t) => ({ role: t.role, content: t.blocks })),
  };
  if (systemParts.length > 0) body.system = [{ text: systemParts.join("\n\n") }];

  const inferenceConfig: Record<string, unknown> = {};
  if (req.temperature !== undefined) inferenceConfig.temperature = req.temperature;
  if (req.top_p !== undefined) inferenceConfig.topP = req.top_p;
  if (req.max_tokens !== undefined) inferenceConfig.maxTokens = req.max_tokens;
  if (req.stop !== undefined) {
    inferenceConfig.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  }
  if (Object.keys(inferenceConfig).length > 0) body.inferenceConfig = inferenceConfig;

  const sendTools = req.tool_choice !== "none" && req.tools !== undefined && req.tools.length > 0;
  if (sendTools) {
    body.toolConfig = {
      tools: req.tools!.map((t) => ({
        toolSpec: {
          name: t.function.name,
          ...(t.function.description !== undefined ? { description: t.function.description } : {}),
          inputSchema: { json: t.function.parameters },
        },
      })),
    };
    const choice = req.tool_choice;
    if (choice === "auto") (body.toolConfig as Record<string, unknown>).toolChoice = { auto: {} };
    else if (choice === "required") (body.toolConfig as Record<string, unknown>).toolChoice = { any: {} };
    else if (typeof choice === "object") {
      (body.toolConfig as Record<string, unknown>).toolChoice = { tool: { name: choice.function.name } };
    }
  }

  // Request-level extras ride along under the bedrock namespace. Applied
  // last so explicit keys win over translated ones.
  const extra = req.providerOptions?.bedrock;
  if (extra && typeof extra === "object") Object.assign(body, extra);
  return body;
}

function toUsage(v: unknown): Usage | null {
  if (typeof v !== "object" || v === null) return null;
  const u = v as Record<string, unknown>;
  const input = u.inputTokens;
  const output = u.outputTokens;
  if (typeof input !== "number" || typeof output !== "number") return null;
  const cacheRead = typeof u.cacheReadInputTokens === "number" ? u.cacheReadInputTokens : 0;
  const cacheWrite = typeof u.cacheWriteInputTokens === "number" ? u.cacheWriteInputTokens : 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: typeof u.totalTokens === "number" ? u.totalTokens : input + output,
    ...(cacheRead > 0 ? { cached_tokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cache_write_tokens: cacheWrite } : {}),
  };
}

/** Converse response -> unified ChatResponse. */
export function translateResponse(json: unknown, providerModel: string): ChatResponse {
  const j = json as Record<string, unknown>;
  const output = (j.output ?? {}) as Record<string, unknown>;
  const message = (output.message ?? {}) as Record<string, unknown>;
  const blocks = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [];

  let text = "";
  let reasoning = "";
  const toolCalls: ToolCall[] = [];
  for (const block of blocks) {
    if (typeof block.text === "string") {
      text += block.text;
    } else if (typeof block.reasoningContent === "object" && block.reasoningContent !== null) {
      const rc = block.reasoningContent as Record<string, unknown>;
      if (typeof rc.text === "string") reasoning += rc.text;
    } else if (typeof block.toolUse === "object" && block.toolUse !== null) {
      const tu = block.toolUse as Record<string, unknown>;
      toolCalls.push({
        id: typeof tu.toolUseId === "string" ? tu.toolUseId : "",
        type: "function",
        function: {
          name: typeof tu.name === "string" ? tu.name : "",
          arguments: JSON.stringify(tu.input ?? {}),
        },
      });
    }
  }

  return {
    id: typeof j.messageId === "string" ? j.messageId : "",
    model: providerModel,
    provider: "bedrock",
    created: 0,
    usage: toUsage(j.usage),
    choices: [
      {
        index: 0,
        finish_reason: mapBedrockStopReason(j.stopReason),
        message: {
          role: "assistant",
          content: text !== "" ? text : toolCalls.length > 0 ? null : "",
          ...(reasoning !== "" ? { reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
  };
}

// ------------------------------------------------------------------ adapter

function converseUrl(route: NormalizedRoute, action: "converse" | "converse-stream"): string {
  return `${baseUrl(route)}/model/${encodeURIComponent(route.model)}/${action}`;
}

async function signedRequest(
  route: NormalizedRoute,
  key: string,
  url: string,
  body: Record<string, unknown>,
  ctx: AdapterContext,
): Promise<Response> {
  const region = route.region;
  if (!region) {
    throw new ConfigError(`route "${route.id}": bedrock provider requires region`);
  }
  const bytes = encoder.encode(JSON.stringify(body));
  const headers = await sigv4Headers({
    method: "POST",
    url,
    body: bytes,
    credentials: parseAwsCredentials(key),
    region,
  });
  try {
    return await fetchWithTimeout(
      ctx.fetchImpl,
      url,
      { method: "POST", headers, body: bytes },
      { timeoutMs: route.timeoutMs, signal: ctx.signal },
    );
  } catch (err) {
    throw toNetworkError("bedrock", err);
  }
}

export class BedrockAdapter implements ProviderAdapter {
  readonly id = "bedrock";

  /**
   * Verbatim passthrough. No requireOk, no translation, no retries.
   * SigV4 signs only content-type/host/x-amz-date — do not override
   * content-type via opts.headers (unsigned mismatch -> signature error).
   */
  async raw(
    route: NormalizedRoute,
    key: string,
    opts: RawRequestOptions,
    ctx: AdapterContext,
  ): Promise<Response> {
    const url = `${baseUrl(route)}${opts.path ?? `/model/${encodeURIComponent(route.model)}/converse`}`;
    const bodyBytes = encoder.encode(
      opts.body === undefined ? "{}" : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
    );
    const region = route.region;
    if (!region) {
      throw new ConfigError(`route "${route.id}": bedrock provider requires region`);
    }
    let headers: Record<string, string>;
    try {
      headers = await sigv4Headers({
        method: opts.method ?? "POST",
        url,
        body: bodyBytes,
        credentials: parseAwsCredentials(key),
        region,
      });
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      throw toNetworkError("bedrock", err);
    }
    try {
      return await fetchWithTimeout(
        ctx.fetchImpl,
        url,
        {
          method: opts.method ?? "POST",
          headers: { ...headers, ...(opts.headers ?? {}) },
          ...(opts.body !== undefined ? { body: bodyBytes } : {}),
        },
        { timeoutMs: route.timeoutMs, signal: ctx.signal },
      );
    } catch (err) {
      throw toNetworkError("bedrock", err);
    }
  }

  async complete(
    route: NormalizedRoute,
    key: string,
    req: ChatRequest,
    ctx: AdapterContext,
  ): Promise<ChatResponse> {
    const resp = await signedRequest(
      route, key,
      converseUrl(route, "converse"),
      translateRequest(req, route.model, false),
      ctx,
    );
    await requireOk(resp, "bedrock");
    const json = await resp.json();
    return translateResponse(json, route.model);
  }

  async stream(
    route: NormalizedRoute,
    key: string,
    req: ChatRequest,
    ctx: AdapterContext,
  ): Promise<AsyncIterable<ChatChunk>> {
    const resp = await signedRequest(
      route, key,
      converseUrl(route, "converse-stream"),
      translateRequest(req, route.model, true),
      ctx,
    );
    await requireOk(resp, "bedrock");
    const body = resp.body;
    if (!body) throw new ProviderError("bedrock", "network", "bedrock: empty stream body");
    const model = route.model;

    return (async function* () {
      let servedModel = model;
      let roleSent = false;
      let finish: string | null = null;
      let usage: Usage | null = null;

      const ensureRole = function* (): Generator<ChatChunk> {
        if (!roleSent) {
          roleSent = true;
          yield { id: "", model: servedModel, provider: "bedrock", delta: { role: "assistant" }, finish_reason: null };
        }
      };

      for await (const msg of awsEventStream(body)) {
        const eventType = msg.headers.get(":event-type");
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(new TextDecoder().decode(msg.payload)) as Record<string, unknown>;
        } catch {
          continue;
        }

        switch (eventType) {
          case "contentBlockDelta": {
            const delta = (ev.delta ?? {}) as Record<string, unknown>;
            const index = typeof ev.contentBlockIndex === "number" ? ev.contentBlockIndex : 0;
            if (typeof delta.text === "string" && delta.text !== "") {
              yield* ensureRole();
              yield { id: "", model: servedModel, provider: "bedrock", delta: { content: delta.text }, finish_reason: null };
            } else if (
              typeof delta.reasoningContent === "object" &&
              delta.reasoningContent !== null &&
              typeof (delta.reasoningContent as Record<string, unknown>).text === "string"
            ) {
              yield* ensureRole();
              yield {
                id: "",
                model: servedModel,
                provider: "bedrock",
                delta: { reasoning: (delta.reasoningContent as Record<string, unknown>).text as string },
                finish_reason: null,
              };
            } else if (typeof delta.toolUse === "object" && delta.toolUse !== null) {
              const tu = delta.toolUse as Record<string, unknown>;
              if (typeof tu.input === "string" && tu.input !== "") {
                yield* ensureRole();
                const d: Delta = {
                  tool_calls: [{ index, function: { arguments: tu.input } }],
                };
                yield { id: "", model: servedModel, provider: "bedrock", delta: d, finish_reason: null };
              }
            }
            break;
          }
          case "contentBlockStart": {
            const start = (ev.start ?? {}) as Record<string, unknown>;
            if (typeof start.toolUse === "object" && start.toolUse !== null) {
              const tu = start.toolUse as Record<string, unknown>;
              yield* ensureRole();
              const d: Delta = {
                tool_calls: [
                  {
                    index: typeof ev.contentBlockIndex === "number" ? ev.contentBlockIndex : 0,
                    ...(typeof tu.toolUseId === "string" ? { id: tu.toolUseId } : {}),
                    type: "function",
                    function: { name: typeof tu.name === "string" ? tu.name : "", arguments: "" },
                  },
                ],
              };
              yield { id: "", model: servedModel, provider: "bedrock", delta: d, finish_reason: null };
            }
            break;
          }
          case "messageStop": {
            finish = mapBedrockStopReason(ev.stopReason);
            break;
          }
          case "metadata": {
            const u = toUsage(ev.usage);
            if (u) usage = u;
            break;
          }
          case "internalServerException":
          case "throttlingException":
          case "validationException":
          case "modelStreamErrorException":
          case "serviceUnavailableException": {
            throw new ProviderError(
              "bedrock",
              eventType === "throttlingException" ? "rate_limit" : "server",
              `bedrock: ${eventType}`,
              { body: ev },
            );
          }
          default:
            break; // messageStart, contentBlockStop
        }
      }

      if (finish !== null || usage !== null) {
        yield {
          id: "",
          model: servedModel,
          provider: "bedrock",
          delta: {},
          finish_reason: finish,
          ...(usage ? { usage } : {}),
        };
      }
    })();
  }

  // No embed(): bedrock embedding models use invoke-model with
  // model-specific payloads — go through router.raw().
}
