import "dart:async";
import "package:http/http.dart" as http;
import "config/parse.dart";
import "config/schema.dart";
import "engine.dart";
import "providers/types.dart";
import "routing/health.dart";
import "routing/outcomes.dart";
import "types.dart";

/// Public AIRouter facade. Embeddable LLM router for Dart and Flutter.
class AIRouter {
  final RoutingEngine engine;

  AIRouter._(this.engine);

  factory AIRouter(
    Object config, {
    Map<String, String>? env,
    EngineOptions options = const EngineOptions(),
  }) {
    final parsedConfig = config is RouterConfig
        ? config
        : parseConfig(config, env);
    return AIRouter._(RoutingEngine(parsedConfig, options));
  }

  HealthTracker get health => engine.health;
  OutcomeTracker get outcomes => engine.outcomes;

  Future<ChatResponse> complete(
    ChatRequest req, [
    CallOptions? options,
  ]) =>
      engine.complete(req, options);

  Future<Stream<ChatChunk>> stream(
    ChatRequest req, [
    CallOptions? options,
  ]) =>
      engine.stream(req, options);

  Future<http.Response> raw(
    String routeId,
    RawRequestOptions opts, [
    CallOptions? options,
  ]) =>
      engine.raw(routeId, opts, options);

  Future<EmbeddingResponse> embed(
    EmbeddingRequest req, [
    CallOptions? options,
  ]) =>
      engine.embed(req, options);

  void recordOutcome(OutcomeEvent event) {
    engine.outcomes.record(event);
  }
}
