import "dart:async";
import "package:http/http.dart" as http;
import "../config/schema.dart";
import "../routing/capabilities.dart";
import "../types.dart";

/// A validated route with defaults applied. Produced by the engine.
class NormalizedRoute {
  final String id;
  final ProviderId provider;
  final String model;
  final String? apiKey;
  final List<String>? apiKeys;
  final String? baseUrl;
  final String? apiVersion;
  final String? region;
  final String? project;
  final Map<String, String> headers;
  final int maxRetries;
  final int timeoutMs;
  final int? streamIdleTimeoutMs;
  final LimitRule? limit;
  final BudgetRule? budget;
  final double? weight;
  final ModelCapabilities? capabilities;

  /// Adapter id resolved from `provider` (preset ids expand to their wire
  /// family's adapter; built-in and registered ids map to themselves).
  final String? adapterId;
  /// Auth header name override (from a preset's `{ header }` auth).
  final String? authHeaderName;
  final List<String> keyPool;
  final LimitRule limits;

  const NormalizedRoute({
    required this.id,
    required this.provider,
    required this.model,
    this.apiKey,
    this.apiKeys,
    this.baseUrl,
    this.apiVersion,
    this.region,
    this.project,
    required this.headers,
    required this.maxRetries,
    required this.timeoutMs,
    this.streamIdleTimeoutMs,
    this.limit,
    this.budget,
    this.weight,
    this.capabilities,
    this.adapterId,
    this.authHeaderName,
    required this.keyPool,
    required this.limits,
  });

  ModelRoute toModelRoute() => ModelRoute(
        id: id,
        provider: provider,
        model: model,
        apiKey: apiKey,
        apiKeys: apiKeys,
        baseUrl: baseUrl,
        apiVersion: apiVersion,
        region: region,
        project: project,
        headers: headers,
        maxRetries: maxRetries,
        timeoutMs: timeoutMs,
        streamIdleTimeoutMs: streamIdleTimeoutMs,
        limit: limit,
        budget: budget,
        weight: weight,
        capabilities: capabilities,
      );
}

typedef FetchLike = Future<http.Response> Function(
  Uri url, {
  Map<String, String>? headers,
  Object? body,
  Duration? timeout,
  Completer<void>? cancelCompleter,
  bool streaming,
});

class AdapterContext {
  final http.Client? client;
  final Completer<void>? cancelCompleter;

  const AdapterContext({
    this.client,
    this.cancelCompleter,
  });
}

/// Options for the raw escape hatch (`router.raw`).
class RawRequestOptions {
  /// Path relative to the route's base URL. Defaults to the provider's chat endpoint.
  final String? path;
  /// Request body. Objects are JSON-encoded; strings pass through verbatim.
  final Object? body;
  /// Extra headers merged over the adapter's auth/content-type defaults.
  final Map<String, String>? headers;
  /// HTTP method. Default "POST".
  final String? method;
  final Completer<void>? cancelCompleter;

  const RawRequestOptions({
    this.path,
    this.body,
    this.headers,
    this.method,
    this.cancelCompleter,
  });
}

/// A provider adapter speaks one provider's wire protocol. Methods receive the
/// already-selected key so key rotation stays engine-owned.
abstract class ProviderAdapter {
  String get id;

  Future<ChatResponse> complete(
    NormalizedRoute route,
    String key,
    ChatRequest req,
    AdapterContext ctx,
  );

  Future<Stream<ChatChunk>> stream(
    NormalizedRoute route,
    String key,
    ChatRequest req,
    AdapterContext ctx,
  );

  Future<http.Response> raw(
    NormalizedRoute route,
    String key,
    RawRequestOptions opts,
    AdapterContext ctx,
  );

  Future<EmbeddingResponse> embed(
    NormalizedRoute route,
    String key,
    EmbeddingRequest req,
    AdapterContext ctx,
  );
}
