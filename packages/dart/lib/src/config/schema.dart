/// JSON-serializable router config. This shape is the cross-language contract:
/// the Python SDK validates against the same schema and the conformance
/// fixtures in /conformance are data-driven from it.

import "../routing/capabilities.dart";

const List<String> providerIds = [
  "openai",
  "openai-compatible",
  "azure",
  "anthropic",
  "gemini",
  "bedrock",
  "vertex",
];

typedef ProviderId = String;

class LimitRule {
  final int? rpm;
  final int? tpm;

  const LimitRule({this.rpm, this.tpm});

  factory LimitRule.fromJson(Map<String, dynamic> json) => LimitRule(
        rpm: json["rpm"] as int?,
        tpm: json["tpm"] as int?,
      );

  Map<String, dynamic> toJson() => {
        if (rpm != null) "rpm": rpm,
        if (tpm != null) "tpm": tpm,
      };
}

class BudgetRule {
  final double usd;
  final int? windowMs;

  const BudgetRule({
    required this.usd,
    this.windowMs,
  });

  factory BudgetRule.fromJson(Map<String, dynamic> json) => BudgetRule(
        usd: (json["usd"] as num).toDouble(),
        windowMs: json["windowMs"] as int?,
      );

  Map<String, dynamic> toJson() => {
        "usd": usd,
        if (windowMs != null) "windowMs": windowMs,
      };
}

class ModelRoute {
  final String id;
  final ProviderId provider;
  final String model;
  final String? apiKey;
  final List<String>? apiKeys;
  final String? baseUrl;
  final String? apiVersion;
  final String? region;
  final String? project;
  final Map<String, String>? headers;
  final int? maxRetries;
  final int? timeoutMs;
  final int? streamIdleTimeoutMs;
  final LimitRule? limit;
  final BudgetRule? budget;
  final double? weight;
  final ModelCapabilities? capabilities;

  const ModelRoute({
    required this.id,
    required this.provider,
    required this.model,
    this.apiKey,
    this.apiKeys,
    this.baseUrl,
    this.apiVersion,
    this.region,
    this.project,
    this.headers,
    this.maxRetries,
    this.timeoutMs,
    this.streamIdleTimeoutMs,
    this.limit,
    this.budget,
    this.weight,
    this.capabilities,
  });

  Map<String, dynamic> toJson() => {
        "id": id,
        "provider": provider,
        "model": model,
        if (apiKey != null) "apiKey": apiKey,
        if (apiKeys != null) "apiKeys": apiKeys,
        if (baseUrl != null) "baseUrl": baseUrl,
        if (apiVersion != null) "apiVersion": apiVersion,
        if (region != null) "region": region,
        if (project != null) "project": project,
        if (headers != null) "headers": headers,
        if (maxRetries != null) "maxRetries": maxRetries,
        if (timeoutMs != null) "timeoutMs": timeoutMs,
        if (streamIdleTimeoutMs != null) "streamIdleTimeoutMs": streamIdleTimeoutMs,
        if (limit != null) "limit": limit!.toJson(),
        if (budget != null) "budget": budget!.toJson(),
        if (weight != null) "weight": weight,
        if (capabilities != null) "capabilities": capabilities!.toJson(),
      };
}

typedef RoutingStrategy = String;

class RoutingStrategies {
  static const String fallback = "fallback";
  static const String roundRobin = "round-robin";
  static const String weighted = "weighted";
  static const String leastLatency = "least-latency";
  static const String cheapest = "cheapest";
  static const String balanced = "balanced";
  static const String qualityFirst = "quality-first";
}

class PolicyWeights {
  final double? cost;
  final double? speed;
  final double? reliability;

  const PolicyWeights({
    this.cost,
    this.speed,
    this.reliability,
  });

  factory PolicyWeights.fromJson(Map<String, dynamic> json) => PolicyWeights(
        cost: (json["cost"] as num?)?.toDouble(),
        speed: (json["speed"] as num?)?.toDouble(),
        reliability: (json["reliability"] as num?)?.toDouble(),
      );

  Map<String, dynamic> toJson() => {
        if (cost != null) "cost": cost,
        if (speed != null) "speed": speed,
        if (reliability != null) "reliability": reliability,
      };
}

class RouterConfig {
  final List<ModelRoute> routes;
  final RoutingStrategy? strategy;
  final PolicyWeights? weights;

  const RouterConfig({
    required this.routes,
    this.strategy,
    this.weights,
  });

  Map<String, dynamic> toJson() => {
        "routes": routes.map((r) => r.toJson()).toList(),
        if (strategy != null) "strategy": strategy,
        if (weights != null) "weights": weights!.toJson(),
      };
}
