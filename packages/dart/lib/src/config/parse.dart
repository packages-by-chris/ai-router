import "dart:io";
import "../errors.dart";
import "../providers/presets.dart";
import "../providers/registry.dart";
import "../routing/capabilities.dart";
import "schema.dart";

final _envPattern = RegExp(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}");

const Set<String> _topLevelFields = {"routes", "strategy", "weights"};
const Set<String> _weightFields = {"cost", "speed", "reliability"};
const Set<String> _routeFields = {
  "id",
  "provider",
  "model",
  "apiKey",
  "apiKeys",
  "baseUrl",
  "apiVersion",
  "region",
  "project",
  "headers",
  "maxRetries",
  "timeoutMs",
  "streamIdleTimeoutMs",
  "limit",
  "budget",
  "weight",
  "capabilities",
};
const Set<String> _limitFields = {"rpm", "tpm"};
const Set<String> _budgetFields = {"usd", "windowMs"};
const Set<String> _capabilityFields = {
  "streaming",
  "tools",
  "vision",
  "json",
  "structuredOutput",
  "reasoning",
  "audio",
  "embeddings",
  "multimodal",
  "longContext",
  "contextWindow",
};
const Set<String> _strategies = {
  "fallback",
  "round-robin",
  "weighted",
  "least-latency",
  "cheapest",
  "balanced",
  "quality-first",
};

Object? _interpolateEnv(
  Object? value,
  Map<String, String> env,
  String path,
) {
  if (value is! String) return value;
  if (!value.contains(r"${")) return value;
  return value.replaceAllMapped(_envPattern, (match) {
    final varName = match.group(1)!;
    final resolved = env[varName];
    if (resolved == null) {
      throw ConfigError('$path: environment variable "$varName" is not set');
    }
    return resolved;
  });
}

Object? _interpolateDeep(
  Object? obj,
  Map<String, String> env,
  String path,
) {
  if (obj is String) return _interpolateEnv(obj, env, path);
  if (obj is List) {
    return obj.asMap().entries.map((e) {
      return _interpolateDeep(e.value, env, "$path[${e.key}]");
    }).toList();
  }
  if (obj is Map) {
    final result = <String, dynamic>{};
    for (final entry in obj.entries) {
      result[entry.key.toString()] =
          _interpolateDeep(entry.value, env, "$path.${entry.key}");
    }
    return result;
  }
  return obj;
}

bool _isPositiveInt(Object? v) {
  return v is int && v > 0;
}

/// Parses and validates a router config map, resolving `${ENV_VAR}` references.
RouterConfig parseConfig(
  Object? input, [
  Map<String, String>? env,
]) {
  final resolvedEnv = env ?? Platform.environment;
  final interpolated = _interpolateDeep(input, resolvedEnv, "config");

  final errors = <String>[];

  if (interpolated is! Map) {
    throw ConfigError("config: expected an object");
  }

  final configMap = Map<String, dynamic>.from(interpolated);
  final routesRaw = configMap["routes"];

  if (routesRaw is! List) {
    throw ConfigError("config.routes: expected an array");
  }
  if (routesRaw.isEmpty) {
    throw ConfigError("config.routes: must not be empty");
  }

  for (final key in configMap.keys) {
    if (!_topLevelFields.contains(key)) {
      errors.pushUnknownField("config.$key: unknown field (known: routes, strategy, weights)");
    }
  }

  final strategy = configMap["strategy"];
  if (strategy != null && (strategy is! String || !_strategies.contains(strategy))) {
    errors.add(
      'config.strategy: must be "fallback", "round-robin", "weighted", "least-latency", "cheapest", "balanced", or "quality-first"',
    );
  }

  PolicyWeights? weights;
  final rawWeights = configMap["weights"];
  if (rawWeights != null) {
    if (rawWeights is! Map) {
      errors.add("config.weights: expected an object");
    } else {
      final weightsMap = Map<String, dynamic>.from(rawWeights);
      for (final key in weightsMap.keys) {
        if (!_weightFields.contains(key)) {
          errors.add("config.weights.$key: unknown field (known: cost, speed, reliability)");
        }
      }
      double? cost;
      double? speed;
      double? reliability;
      int validCount = 0;

      for (final key in _weightFields) {
        final val = weightsMap[key];
        if (val == null) continue;
        if (val is! num || val <= 0) {
          errors.add("config.weights.$key: must be a positive number");
          continue;
        }
        validCount++;
        if (key == "cost") cost = val.toDouble();
        if (key == "speed") speed = val.toDouble();
        if (key == "reliability") reliability = val.toDouble();
      }

      if (validCount == 0) {
        errors.add("config.weights: expected at least one of cost, speed, reliability");
      } else if (errors.isEmpty) {
        weights = PolicyWeights(cost: cost, speed: speed, reliability: reliability);
      }
    }
  }

  final seenIds = <String>{};
  final routes = <ModelRoute>[];

  for (int i = 0; i < routesRaw.length; i++) {
    final at = "config.routes[$i]";
    final raw = routesRaw[i];
    if (raw is! Map) {
      errors.add("$at: expected an object");
      continue;
    }

    final rMap = Map<String, dynamic>.from(raw);
    for (final key in rMap.keys) {
      if (!_routeFields.contains(key)) {
        errors.add("$at.$key: unknown field");
      }
    }

    final id = rMap["id"];
    if (id is! String || id.isEmpty) {
      errors.add("$at.id: must be a non-empty string");
      continue;
    }
    if (seenIds.contains(id)) {
      errors.add('$at.id: duplicate route id "$id"');
      continue;
    }
    seenIds.add(id);

    final provider = rMap["provider"];
    final known = knownProviderIds();
    if (provider is! String || !known.contains(provider)) {
      errors.add(
        '$at.provider: unknown provider "$provider" (known: ${known.join(", ")})',
      );
      continue;
    }

    final model = rMap["model"];
    if (model is! String || model.isEmpty) {
      errors.add("$at.model: must be a non-empty string");
      continue;
    }

    final keyPool = <String>[];
    if (rMap.containsKey("apiKey")) {
      final apiKey = rMap["apiKey"];
      if (apiKey is! String || apiKey.isEmpty) {
        errors.add("$at.apiKey: must be a non-empty string");
        continue;
      }
      keyPool.add(apiKey);
    }
    if (rMap.containsKey("apiKeys")) {
      final apiKeys = rMap["apiKeys"];
      if (apiKeys is! List ||
          apiKeys.isEmpty ||
          !apiKeys.every((k) => k is String && k.isNotEmpty)) {
        errors.add("$at.apiKeys: must be a non-empty array of non-empty strings");
        continue;
      }
      keyPool.addAll(apiKeys.map((k) => k.toString()));
    }
    if (keyPool.isEmpty) {
      if (getPreset(provider)?.auth != "none") {
        errors.add('$at: needs "apiKey" or "apiKeys"');
        continue;
      }
    }

    if (provider == "openai-compatible" &&
        (rMap["baseUrl"] is! String || (rMap["baseUrl"] as String).isEmpty)) {
      errors.add('$at.baseUrl: required when provider is "openai-compatible"');
      continue;
    }
    if (provider == "azure" &&
        (rMap["baseUrl"] is! String || (rMap["baseUrl"] as String).isEmpty)) {
      errors.add(
          '$at.baseUrl: required when provider is "azure" (resource root, e.g. https://my-res.openai.azure.com)');
      continue;
    }
    if (provider == "azure") {
      if (rMap["apiVersion"] is! String || (rMap["apiVersion"] as String).isEmpty) {
        errors.add('$at.apiVersion: required when provider is "azure" (e.g. "2024-10-21")');
        continue;
      }
    } else if (rMap.containsKey("apiVersion")) {
      errors.add('$at.apiVersion: only valid when provider is "azure"');
      continue;
    }

    for (final check in [
      {"field": "region", "owners": ["bedrock", "vertex"], "hint": 'e.g. "us-east-1"'},
      {"field": "project", "owners": ["vertex"], "hint": "GCP project id"},
    ]) {
      final field = check["field"] as String;
      final owners = check["owners"] as List<String>;
      final hint = check["hint"] as String;
      final val = rMap[field];
      if (owners.contains(provider)) {
        if (val is! String || val.isEmpty) {
          errors.add('$at.$field: required when provider is "$provider" ($hint)');
          continue;
        }
      } else if (val != null) {
        errors.add(
            '$at.$field: only valid when provider is ${owners.map((o) => '"$o"').join(" or ")}');
        continue;
      }
    }

    if (rMap.containsKey("baseUrl") &&
        (rMap["baseUrl"] is! String || (rMap["baseUrl"] as String).isEmpty)) {
      errors.add("$at.baseUrl: must be a non-empty string");
      continue;
    }

    if (rMap.containsKey("weight") &&
        (rMap["weight"] is! num || (rMap["weight"] as num) <= 0)) {
      errors.add("$at.weight: must be a positive number");
      continue;
    }

    Map<String, String>? headers;
    if (rMap.containsKey("headers")) {
      final h = rMap["headers"];
      if (h is! Map || !h.values.every((v) => v is String)) {
        errors.add("$at.headers: must be an object of string -> string");
        continue;
      }
      headers = Map<String, String>.from(h);
    }

    for (final field in ["maxRetries", "timeoutMs", "streamIdleTimeoutMs"]) {
      if (rMap.containsKey(field)) {
        final val = rMap[field];
        if (!_isPositiveInt(val) && !(field == "maxRetries" && val == 0)) {
          errors.add("$at.$field: must be a positive integer");
          continue;
        }
      }
    }

    LimitRule? limit;
    if (rMap.containsKey("limit")) {
      final rawLimit = rMap["limit"];
      if (rawLimit is! Map) {
        errors.add("$at.limit: expected an object");
        continue;
      }
      final lMap = Map<String, dynamic>.from(rawLimit);
      for (final key in lMap.keys) {
        if (!_limitFields.contains(key)) {
          errors.add("$at.limit.$key: unknown field (known: rpm, tpm)");
        }
      }
      int? rpm;
      int? tpm;
      if (lMap.containsKey("rpm")) {
        if (!_isPositiveInt(lMap["rpm"])) {
          errors.add("$at.limit.rpm: must be a positive integer");
          continue;
        }
        rpm = lMap["rpm"] as int;
      }
      if (lMap.containsKey("tpm")) {
        if (!_isPositiveInt(lMap["tpm"])) {
          errors.add("$at.limit.tpm: must be a positive integer");
          continue;
        }
        tpm = lMap["tpm"] as int;
      }
      limit = LimitRule(rpm: rpm, tpm: tpm);
    }

    BudgetRule? budget;
    if (rMap.containsKey("budget")) {
      final rawBudget = rMap["budget"];
      if (rawBudget is! Map) {
        errors.add("$at.budget: expected an object");
        continue;
      }
      final bMap = Map<String, dynamic>.from(rawBudget);
      for (final key in bMap.keys) {
        if (!_budgetFields.contains(key)) {
          errors.add("$at.budget.$key: unknown field (known: usd, windowMs)");
        }
      }
      if (bMap["usd"] is! num || (bMap["usd"] as num) <= 0) {
        errors.add("$at.budget.usd: must be a positive number");
        continue;
      }
      int? windowMs;
      if (bMap.containsKey("windowMs")) {
        if (!_isPositiveInt(bMap["windowMs"])) {
          errors.add("$at.budget.windowMs: must be a positive integer");
          continue;
        }
        windowMs = bMap["windowMs"] as int;
      }
      budget = BudgetRule(usd: (bMap["usd"] as num).toDouble(), windowMs: windowMs);
    }

    ModelCapabilities? capabilities;
    if (rMap.containsKey("capabilities")) {
      final rawCaps = rMap["capabilities"];
      if (rawCaps is! Map) {
        errors.add("$at.capabilities: expected an object");
        continue;
      }
      final cMap = Map<String, dynamic>.from(rawCaps);
      for (final key in cMap.keys) {
        if (!_capabilityFields.contains(key)) {
          errors.add(
              "$at.capabilities.$key: unknown field (known: ${_capabilityFields.join(", ")})");
        }
      }
      final capsJson = <String, dynamic>{};
      for (final key in _capabilityFields) {
        final val = cMap[key];
        if (val == null) continue;
        if (key == "contextWindow") {
          if (!_isPositiveInt(val)) {
            errors.add("$at.capabilities.contextWindow: must be a positive integer");
            continue;
          }
          capsJson[key] = val as int;
        } else {
          if (val is! bool) {
            errors.add("$at.capabilities.$key: must be a boolean");
            continue;
          }
          capsJson[key] = val;
        }
      }
      capabilities = ModelCapabilities.fromJson(capsJson);
    }

    routes.add(ModelRoute(
      id: id,
      provider: provider,
      model: model,
      apiKey: rMap["apiKey"] as String?,
      apiKeys: (rMap["apiKeys"] as List?)?.map((e) => e.toString()).toList(),
      baseUrl: rMap["baseUrl"] as String?,
      apiVersion: rMap["apiVersion"] as String?,
      region: rMap["region"] as String?,
      project: rMap["project"] as String?,
      headers: headers,
      maxRetries: rMap["maxRetries"] as int?,
      timeoutMs: rMap["timeoutMs"] as int?,
      streamIdleTimeoutMs: rMap["streamIdleTimeoutMs"] as int?,
      limit: limit,
      budget: budget,
      weight: (rMap["weight"] as num?)?.toDouble(),
      capabilities: capabilities,
    ));
  }

  if (errors.isNotEmpty) {
    throw ConfigError(errors.join("\n"));
  }

  return RouterConfig(
    routes: routes,
    strategy: strategy as String?,
    weights: weights,
  );
}

extension _ErrorListExt on List<String> {
  void pushUnknownField(String msg) => add(msg);
}
