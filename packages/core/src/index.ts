// Public surface of @ai-router/core.

export { AIRouter, type AIRouterOptions } from "./router.js";
export { RoutingEngine, estimateTokens, computeCost } from "./engine.js";
export type {
  AttemptEvent,
  AttemptOutcome,
  CallOptions,
  CallSummaryEvent,
  EngineOptions,
  LogEvent,
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
export {
  GuardrailBlockedError,
  runGuardrails,
} from "./guardrails.js";
export type {
  GuardrailVerdict,
  Guardrails,
  InputGuardrail,
  OutputGuardrail,
} from "./guardrails.js";
export { MemoryStore } from "./limiter/memory.js";
export type { RateLimitDecision, RateLimitStore } from "./limiter/store.js";
export { OpenAIAdapter, OPENAI_DEFAULT_BASE_URL, providerLabel as openaiProviderLabel, mergeProviderOptions, usageDetails, translateChunk, translateRequest, translateResponse } from "./providers/openai.js";
export { AzureAdapter, AZURE_DEFAULT_API_VERSION } from "./providers/azure.js";
export {
  BedrockAdapter,
  awsEventStream,
  mapBedrockStopReason,
  sigv4Headers,
  translateRequest as translateBedrockRequest,
  translateResponse as translateBedrockResponse,
} from "./providers/bedrock.js";
export type { AwsEventStreamMessage } from "./providers/bedrock.js";
export {
  VertexAdapter,
  VERTEX_TOKEN_ENDPOINT,
  VERTEX_TOKEN_SCOPE,
  clearVertexTokenCache,
  resolveVertexToken,
} from "./providers/vertex.js";
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
export { getAdapter, isSupported, registerAdapter, knownProviderIds } from "./providers/registry.js";
export { PROVIDER_PRESETS, getPreset } from "./providers/presets.js";
export type { PresetAuth, ProviderPreset } from "./providers/presets.js";
export {
  BUILTIN_TRANSLATION_HANDLERS,
  runTranslationCase,
  runTranslationCases,
  stable as stableJson,
} from "./conformance/cases.js";
export type {
  CaseResult,
  TranslationCase,
  TranslationHandlers,
} from "./conformance/cases.js";
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
