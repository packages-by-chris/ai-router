/// ai_router: Embeddable LLM routing engine for Dart & Flutter.
///
/// Features:
/// - fallback chains with ordered (or scored) candidate selection
/// - retry / key-rotation / circuit-breaking
/// - rate-limit + USD-budget gating through a pluggable store
/// - capability-aware, cost-aware, latency-aware, and quality-aware routing
/// - streaming commit boundary that makes mid-stream provider swaps impossible
/// - unified request/response translation for OpenAI, Anthropic, Gemini, Bedrock, Vertex, and OpenAI-compatible endpoints.

library ai_router;

export "src/config/parse.dart";
export "src/config/schema.dart";
export "src/engine.dart";
export "src/errors.dart";
export "src/guardrails.dart";
export "src/limiter/memory.dart";
export "src/limiter/store.dart";
export "src/providers/anthropic.dart" show AnthropicAdapter;
export "src/providers/azure.dart" show AzureAdapter;
export "src/providers/bedrock.dart" show BedrockAdapter;
export "src/providers/gemini.dart" show GeminiAdapter;
export "src/providers/openai.dart" show OpenAIAdapter;
export "src/providers/presets.dart";
export "src/providers/registry.dart";
export "src/providers/types.dart";
export "src/providers/vertex.dart" show VertexAdapter;
export "src/router.dart";
export "src/routing/capabilities.dart";
export "src/routing/health.dart";
export "src/routing/order.dart";
export "src/routing/outcomes.dart";
export "src/routing/state.dart";
export "src/stream.dart";
export "src/types.dart";
