// Public surface of @ai-router/core.

export { AIRouter, type AIRouterOptions } from "./router.js";
export { RoutingEngine, estimateTokens, computeCost } from "./engine.js";
export type {
  AttemptEvent,
  AttemptOutcome,
  CallOptions,
  CallSummaryEvent,
  EngineOptions,
  Middleware,
  RequestContext,
  RouterStats,
} from "./engine.js";
export { parseConfig } from "./config/parse.js";
export type {
  BudgetRule,
  LimitRule,
  ModelRoute,
  ProviderId,
  RouterConfig,
} from "./config/schema.js";
export { PROVIDER_IDS } from "./config/schema.js";
export {
  AIRouterError,
  AllRoutesFailedError,
  ConfigError,
  ProviderError,
  RateLimitedError,
  UnsupportedProviderError,
  classifyStatus,
  isKeyRelatedKind,
  isRetryableKind,
} from "./errors.js";
export type { AttemptRecord, ErrorKind, ProviderErrorOptions } from "./errors.js";
export { MemoryStore } from "./limiter/memory.js";
export type { RateLimitDecision, RateLimitStore } from "./limiter/store.js";
export { OpenAIAdapter, OPENAI_DEFAULT_BASE_URL, providerLabel as openaiProviderLabel, mergeProviderOptions, usageDetails, translateChunk, translateRequest, translateResponse } from "./providers/openai.js";
export { AzureAdapter, AZURE_DEFAULT_API_VERSION } from "./providers/azure.js";
export {
  AnthropicAdapter,
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_THINKING_BUDGETS,
  ANTHROPIC_VERSION,
  mapFinishReason as mapAnthropicFinishReason,
  translateRequest as translateAnthropicRequest,
  translateResponse as translateAnthropicResponse,
} from "./providers/anthropic.js";
export {
  GeminiAdapter,
  GEMINI_DEFAULT_BASE_URL,
  GEMINI_THINKING_BUDGETS,
  mapFinishReason as mapGeminiFinishReason,
  translateRequest as translateGeminiRequest,
  translateResponse as translateGeminiResponse,
} from "./providers/gemini.js";
export { getAdapter, isSupported } from "./providers/registry.js";
export type { AdapterContext, NormalizedRoute, ProviderAdapter, RawRequestOptions } from "./providers/types.js";
export { parseRetryAfter, fetchWithTimeout, isAbortError, toNetworkError } from "./http/request.js";
export type { FetchLike } from "./http/request.js";
export { sseData, streamFromChunks } from "./http/sse.js";
export { streamText, collectStream } from "./stream.js";
export type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  Choice,
  Delta,
  EmbeddingData,
  EmbeddingRequest,
  EmbeddingResponse,
  ProviderOptions,
  ResponseFormat,
  Role,
  TokenPrice,
  Tool,
  ToolCall,
  ToolCallDelta,
  Usage,
} from "./types.js";
