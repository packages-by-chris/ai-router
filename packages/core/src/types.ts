/**
 * Unified request/response types.
 *
 * The unified surface intentionally mirrors the OpenAI chat-completions shape
 * (the de facto lingua franca) so that translation layers stay thin and the
 * raw escape hatch stays natural. Provider adapters translate both directions.
 *
 * Anything the unified layer does not model (thinking blocks, server tools,
 * json_schema responses...) goes through `router.raw()` instead of growing
 * half-translated fields here.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Unified multimodal content parts (OpenAI-style shapes as the base). */
export interface TextPart {
  type: "text";
  text: string;
}

export interface ImageUrlPart {
  type: "image_url";
  image_url: {
    /** https(s) URL or a `data:<mime>;base64,<data>` URI. */
    url: string;
    /** OpenAI-only hint; other providers drop it. */
    detail?: "auto" | "low" | "high";
  };
}

export type ContentPart = TextPart | ImageUrlPart;

export interface ChatMessage {
  role: Role;
  /** Plain text, or multimodal parts (user messages). */
  content: string | ContentPart[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface Tool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

/** Logical request. `model` is a route id from the config, not a provider model name. */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: Tool[];
  tool_choice?: "none" | "auto" | "required" | { type: "function"; function: { name: string } };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  response_format?: { type: "text" | "json_object" };
  user?: string;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** USD price per 1M tokens, used by engine cost accounting. */
export interface TokenPrice {
  input: number;
  output: number;
}

export interface ChatResponse {
  id: string;
  model: string;
  /** Provider that actually served the request (useful after fallback). */
  provider: string;
  created: number;
  choices: Choice[];
  usage: Usage | null;
  /** Estimated USD cost when `pricing` is configured (route id or model match). */
  cost_usd?: number;
}

export interface Choice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

export interface Delta {
  role?: Role;
  content?: string;
  tool_calls?: ToolCallDelta[];
}

/** Stream chunk. `usage` appears on the final chunk when the provider reports it. */
export interface ChatChunk {
  id: string;
  model: string;
  provider: string;
  delta: Delta;
  finish_reason: string | null;
  usage?: Usage;
  cost_usd?: number;
}

// ---------------------------------------------------------------- embeddings

/** Logical embedding request. `model` is a route id from the config. */
export interface EmbeddingRequest {
  model: string;
  input: string | string[];
}

export interface EmbeddingData {
  index: number;
  embedding: number[];
}

export interface EmbeddingResponse {
  object: "list";
  model: string;
  /** Provider that actually served the request (useful after fallback). */
  provider: string;
  data: EmbeddingData[];
  usage: Usage | null;
  /** Estimated USD cost when `pricing` is configured (route id or model match). */
  cost_usd?: number;
}
