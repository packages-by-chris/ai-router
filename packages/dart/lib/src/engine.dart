import "dart:async";
import "dart:math" as math;
import "package:http/http.dart" as http;
import "config/schema.dart";
import "errors.dart";
import "guardrails.dart";
import "limiter/memory.dart";
import "limiter/store.dart";
import "providers/presets.dart";
import "providers/registry.dart";
import "providers/types.dart";
import "routing/capabilities.dart";
import "routing/health.dart";
import "routing/order.dart";
import "routing/outcomes.dart";
import "routing/state.dart";
import "types.dart";

const int defaultMaxRetries = 2;
const int defaultTimeoutMs = 30000;
const int windowMs = 60000;
const int backoffBaseMs = 400;
const int backoffCapMs = 8000;
const double backoffJitter = 0.25;

typedef AttemptOutcome = String;

class AttemptOutcomes {
  static const String ok = "ok";
  static const String error = "error";
  static const String retry = "retry";
  static const String skippedRateLimit = "skipped_rate_limit";
  static const String skippedBudget = "skipped_budget";
  static const String circuitOpen = "circuit_open";
  static const String unsupported = "unsupported";
  static const String capabilityMismatch = "capability_mismatch";
}

class AttemptEvent {
  final String routeId;
  final String provider;
  final String model;
  final AttemptOutcome outcome;
  final int attempts;
  final int? keyIndex;
  final ErrorKind? kind;
  final String? message;
  final double? durationMs;
  final int? retryAfterMs;

  const AttemptEvent({
    required this.routeId,
    required this.provider,
    required this.model,
    required this.outcome,
    required this.attempts,
    this.keyIndex,
    this.kind,
    this.message,
    this.durationMs,
    this.retryAfterMs,
  });

  Map<String, dynamic> toJson() => {
        "routeId": routeId,
        "provider": provider,
        "model": model,
        "outcome": outcome,
        "attempts": attempts,
        if (keyIndex != null) "keyIndex": keyIndex,
        if (kind != null) "kind": kind,
        if (message != null) "message": message,
        if (durationMs != null) "durationMs": durationMs,
        if (retryAfterMs != null) "retryAfterMs": retryAfterMs,
      };
}

class CircuitBreakerOptions {
  final int threshold;
  final int cooldownMs;

  const CircuitBreakerOptions({
    this.threshold = 5,
    this.cooldownMs = 30000,
  });
}

class CallOptions {
  final Completer<void>? cancelCompleter;
  final int? deadlineMs;
  final void Function(AttemptEvent event)? onAttempt;
  final CapabilityRequirement? require;
  final String? task;
  final int? maxTokens;

  const CallOptions({
    this.cancelCompleter,
    this.deadlineMs,
    this.onAttempt,
    this.require,
    this.task,
    this.maxTokens,
  });
}

class EngineOptions {
  final RateLimitStore? store;
  final Map<String, TokenPrice>? pricing;
  final Guardrails? guardrails;
  final CircuitBreakerOptions? circuitBreaker;
  final http.Client? client;
  final double Function()? rng;
  final Future<void> Function(int ms)? sleep;
  final HealthTracker? health;
  final OutcomeTracker? outcomes;

  const EngineOptions({
    this.store,
    this.pricing,
    this.guardrails,
    this.circuitBreaker,
    this.client,
    this.rng,
    this.sleep,
    this.health,
    this.outcomes,
  });
}

NormalizedRoute normalizeRoute(ModelRoute route) {
  final preset = getPreset(route.provider);
  final adapterId = preset?.adapter ?? (isSupported(route.provider) ? route.provider : null);
  final keyPool = <String>[];
  if (route.apiKey != null && route.apiKey!.isNotEmpty) {
    keyPool.add(route.apiKey!);
  }
  if (route.apiKeys != null) {
    keyPool.addAll(route.apiKeys!.where((k) => k.isNotEmpty));
  }
  if (keyPool.isEmpty && preset?.auth == "none") {
    keyPool.add("");
  }

  String? authHeaderName;
  if (preset?.auth is String && preset!.auth != "bearer" && preset.auth != "none") {
    authHeaderName = preset.auth;
  }

  final headers = <String, String>{};
  if (preset?.headers != null) headers.addAll(preset!.headers!);
  if (route.headers != null) headers.addAll(route.headers!);

  return NormalizedRoute(
    id: route.id,
    provider: route.provider,
    model: route.model,
    apiKey: route.apiKey,
    apiKeys: route.apiKeys,
    baseUrl: route.baseUrl ?? preset?.baseUrl,
    apiVersion: route.apiVersion,
    region: route.region,
    project: route.project,
    headers: headers,
    maxRetries: route.maxRetries ?? defaultMaxRetries,
    timeoutMs: route.timeoutMs ?? defaultTimeoutMs,
    streamIdleTimeoutMs: route.streamIdleTimeoutMs,
    limit: route.limit,
    budget: route.budget,
    weight: route.weight,
    capabilities: route.capabilities,
    adapterId: adapterId,
    authHeaderName: authHeaderName,
    keyPool: keyPool,
    limits: route.limit ?? const LimitRule(),
  );
}

int estimateTokens(ChatRequest req) {
  int chars = 0;
  for (final msg in req.messages) {
    if (msg.content is String) {
      chars += (msg.content as String).length;
    } else if (msg.content is List) {
      for (final part in msg.content as List) {
        if (part is TextPart) {
          chars += part.text.length;
        } else if (part is Map && part["text"] is String) {
          chars += (part["text"] as String).length;
        }
      }
    }
  }
  if (req.tools != null) {
    for (final t in req.tools!) {
      chars += t.function.name.length;
      if (t.function.description != null) {
        chars += t.function.description!.length;
      }
    }
  }
  return math.max(1, chars ~/ 4);
}

class _CircuitState {
  int consecutiveFailures = 0;
  int openUntil = 0;
}

class RoutingEngine {
  final RouterConfig config;
  final List<NormalizedRoute> _normalizedRoutes;
  final RateLimitStore _store;
  final Map<String, TokenPrice>? _pricing;
  final Guardrails? _guardrails;
  final CircuitBreakerOptions? _circuitBreaker;
  final http.Client _client;
  final double Function() _rng;
  final Future<void> Function(int ms) _sleep;
  final HealthTracker _health;
  final OutcomeTracker _outcomes;
  final Map<String, _CircuitState> _circuits = {};
  int _rrCounter = 0;

  RoutingEngine(this.config, [EngineOptions options = const EngineOptions()])
      : _normalizedRoutes = config.routes.map(normalizeRoute).toList(),
        _store = options.store ?? MemoryStore(),
        _pricing = options.pricing,
        _guardrails = options.guardrails,
        _circuitBreaker = options.circuitBreaker,
        _client = options.client ?? http.Client(),
        _rng = options.rng ?? math.Random().nextDouble,
        _sleep = options.sleep ?? ((ms) => Future.delayed(Duration(milliseconds: ms))),
        _health = options.health ?? HealthTracker(),
        _outcomes = options.outcomes ?? OutcomeTracker();

  HealthTracker get health => _health;
  OutcomeTracker get outcomes => _outcomes;

  int _backoff(int attempt, int? retryAfterMs) {
    final exp = backoffBaseMs * math.pow(2, attempt).toDouble();
    final capped = math.min(exp, backoffCapMs.toDouble());
    final jitterRange = capped * backoffJitter;
    final jittered = capped - jitterRange + _rng() * 2 * jitterRange;
    if (retryAfterMs != null && retryAfterMs > 0) {
      return math.max(retryAfterMs, jittered.round());
    }
    return jittered.round();
  }

  bool _isCircuitOpen(String routeId) {
    if (_circuitBreaker == null) return false;
    final c = _circuits[routeId];
    if (c == null) return false;
    final now = DateTime.now().millisecondsSinceEpoch;
    return now < c.openUntil;
  }

  void _recordCircuitSuccess(String routeId) {
    _circuits.remove(routeId);
  }

  void _recordCircuitFailure(String routeId) {
    if (_circuitBreaker == null) return;
    final c = _circuits.putIfAbsent(routeId, () => _CircuitState());
    c.consecutiveFailures++;
    if (c.consecutiveFailures >= _circuitBreaker!.threshold) {
      c.openUntil = DateTime.now().millisecondsSinceEpoch + _circuitBreaker!.cooldownMs;
    }
  }

  List<NormalizedRoute> _resolveCandidates(
    String requestedModel,
    ChatRequest req,
    RouteOp op,
    CallOptions? options,
  ) {
    final startIndex = _normalizedRoutes.indexWhere((r) => r.id == requestedModel);
    final slice = startIndex >= 0
        ? _normalizedRoutes.sublist(startIndex)
        : _normalizedRoutes;

    if (slice.isEmpty) return [];

    final arrangeCtx = ArrangeContext(
      strategy: config.strategy,
      op: op == RouteOps.stream ? RouteOpStats.stream : RouteOpStats.complete,
      task: options?.task ?? inferTask(req),
      rng: _rng,
      rrCounter: _rrCounter++,
      health: _health,
      outcomes: _outcomes,
      estimateTokensFn: estimateTokens,
      pricing: _pricing,
      weights: config.weights,
      req: req,
      chain: slice,
    );

    final res = arrangeChain(arrangeCtx);
    return res.chain;
  }

  Future<ChatResponse> complete(ChatRequest req, [CallOptions? options]) async {
    final validatedReq = await runInputGuardrails(_guardrails?.input, req);
    final candidates = _resolveCandidates(validatedReq.model, validatedReq, RouteOps.complete, options);

    final attempts = <AttemptRecord>[];
    final startTime = DateTime.now().millisecondsSinceEpoch;
    final deadline = options?.deadlineMs != null ? startTime + options!.deadlineMs! : null;

    for (final route in candidates) {
      if (deadline != null && DateTime.now().millisecondsSinceEpoch >= deadline) {
        throw DeadlineExceededError(options!.deadlineMs!);
      }

      final rejection = capabilityRejection(
        route.capabilities,
        validatedReq,
        RouteOps.complete,
        options?.require,
        estimateTokens(validatedReq),
      );
      if (rejection != null) {
        final ev = AttemptEvent(
          routeId: route.id,
          provider: route.provider,
          model: route.model,
          outcome: AttemptOutcomes.capabilityMismatch,
          attempts: 0,
          message: rejection,
        );
        options?.onAttempt?.call(ev);
        attempts.add(AttemptRecord(
          routeId: route.id,
          provider: route.provider,
          model: route.model,
          outcome: "capability_mismatch",
          attempts: 0,
          message: rejection,
        ));
        continue;
      }

      if (_isCircuitOpen(route.id)) {
        final ev = AttemptEvent(
          routeId: route.id,
          provider: route.provider,
          model: route.model,
          outcome: AttemptOutcomes.circuitOpen,
          attempts: 0,
          message: "circuit breaker open",
        );
        options?.onAttempt?.call(ev);
        attempts.add(AttemptRecord(
          routeId: route.id,
          provider: route.provider,
          model: route.model,
          outcome: "circuit_open",
          attempts: 0,
          message: "circuit breaker open",
        ));
        continue;
      }

      // Rate limit preflight
      if (route.limits.rpm != null) {
        final decision = await _store.take("rpm:${route.id}", 1, windowMs, route.limits.rpm!);
        if (!decision.allowed) {
          final ev = AttemptEvent(
            routeId: route.id,
            provider: route.provider,
            model: route.model,
            outcome: AttemptOutcomes.skippedRateLimit,
            attempts: 0,
            retryAfterMs: decision.retryAfterMs,
            message: "rpm rate limited",
          );
          options?.onAttempt?.call(ev);
          attempts.add(AttemptRecord(
            routeId: route.id,
            provider: route.provider,
            model: route.model,
            outcome: "skipped_rate_limit",
            attempts: 0,
            retryAfterMs: decision.retryAfterMs,
          ));
          continue;
        }
      }

      // Route execution with retries and key rotation
      final poolSize = route.keyPool.isNotEmpty ? route.keyPool.length : 1;
      int keyIndex = _health.pickKey(route.id, 0, poolSize) ?? 0;
      int tries = 0;
      final maxTries = route.maxRetries + 1;

      while (tries < maxTries) {
        if (deadline != null && DateTime.now().millisecondsSinceEpoch >= deadline) {
          throw DeadlineExceededError(options!.deadlineMs!);
        }

        final apiKey = route.keyPool.isNotEmpty ? route.keyPool[keyIndex % poolSize] : "";
        final adapter = getAdapter(route.adapterId ?? route.provider);
        final attemptStart = DateTime.now().millisecondsSinceEpoch;
        tries++;

        try {
          final res = await adapter.complete(
            route,
            apiKey,
            validatedReq,
            AdapterContext(client: _client, cancelCompleter: options?.cancelCompleter),
          );

          final durationMs = (DateTime.now().millisecondsSinceEpoch - attemptStart).toDouble();
          _health.recordSuccess(route.id, latencyMs: durationMs, op: RouteOpStats.complete);
          _recordCircuitSuccess(route.id);

          if (res.usage != null && route.limits.tpm != null) {
            await _store.record("tpm:${route.id}", res.usage!.totalTokens, windowMs);
          }

          double? costUsd;
          final price = priceLookup(_pricing, route.id, route.model);
          if (price != null && res.usage != null) {
            final inPrice = (res.usage!.promptTokens / 1e6) * price.input;
            final outPrice = (res.usage!.completionTokens / 1e6) * price.output;
            costUsd = ((inPrice + outPrice) * 1e6).round() / 1e6;
          }

          final finalRes = res.copyWith(costUsd: costUsd);
          final guardedRes = await runOutputGuardrails(_guardrails?.output, finalRes);

          final ev = AttemptEvent(
            routeId: route.id,
            provider: route.provider,
            model: route.model,
            outcome: AttemptOutcomes.ok,
            attempts: tries,
            keyIndex: keyIndex,
            durationMs: durationMs,
          );
          options?.onAttempt?.call(ev);

          return guardedRes;
        } on ProviderError catch (err) {
          final durationMs = (DateTime.now().millisecondsSinceEpoch - attemptStart).toDouble();
          _health.recordFailure(
            route.id,
            err.kind,
            keyIndex: keyIndex,
            retryAfterMs: err.retryAfterMs,
            latencyMs: durationMs,
            op: RouteOpStats.complete,
          );

          if (tries >= maxTries || !isRetryableKind(err.kind)) {
            _recordCircuitFailure(route.id);
            final ev = AttemptEvent(
              routeId: route.id,
              provider: route.provider,
              model: route.model,
              outcome: AttemptOutcomes.error,
              attempts: tries,
              keyIndex: keyIndex,
              kind: err.kind,
              message: err.message,
              retryAfterMs: err.retryAfterMs,
            );
            options?.onAttempt?.call(ev);
            attempts.add(AttemptRecord(
              routeId: route.id,
              provider: route.provider,
              model: route.model,
              outcome: "error",
              attempts: tries,
              keyIndex: keyIndex,
              kind: err.kind,
              message: err.message,
              retryAfterMs: err.retryAfterMs,
            ));
            break; // exhausted this route; move to next in fallback chain
          }

          // Rotate key if key-related and pool has more than 1
          if (isKeyRelatedKind(err.kind) && poolSize > 1) {
            keyIndex = (keyIndex + 1) % poolSize;
          }

          final backoffMs = _backoff(tries - 1, err.retryAfterMs);
          final ev = AttemptEvent(
            routeId: route.id,
            provider: route.provider,
            model: route.model,
            outcome: AttemptOutcomes.retry,
            attempts: tries,
            keyIndex: keyIndex,
            kind: err.kind,
            message: err.message,
            retryAfterMs: backoffMs,
          );
          options?.onAttempt?.call(ev);
          await _sleep(backoffMs);
        } catch (err) {
          _recordCircuitFailure(route.id);
          final ev = AttemptEvent(
            routeId: route.id,
            provider: route.provider,
            model: route.model,
            outcome: AttemptOutcomes.error,
            attempts: tries,
            keyIndex: keyIndex,
            message: err.toString(),
          );
          options?.onAttempt?.call(ev);
          attempts.add(AttemptRecord(
            routeId: route.id,
            provider: route.provider,
            model: route.model,
            outcome: "error",
            attempts: tries,
            keyIndex: keyIndex,
            message: err.toString(),
          ));
          break;
        }
      }
    }

    throw AllRoutesFailedError(attempts);
  }

  Future<Stream<ChatChunk>> stream(ChatRequest req, [CallOptions? options]) async {
    final validatedReq = await runInputGuardrails(_guardrails?.input, req);
    final candidates = _resolveCandidates(validatedReq.model, validatedReq, RouteOps.stream, options);

    final attempts = <AttemptRecord>[];
    final startTime = DateTime.now().millisecondsSinceEpoch;
    final deadline = options?.deadlineMs != null ? startTime + options!.deadlineMs! : null;

    for (final route in candidates) {
      if (deadline != null && DateTime.now().millisecondsSinceEpoch >= deadline) {
        throw DeadlineExceededError(options!.deadlineMs!);
      }

      final rejection = capabilityRejection(
        route.capabilities,
        validatedReq,
        RouteOps.stream,
        options?.require,
        estimateTokens(validatedReq),
      );
      if (rejection != null) {
        attempts.add(AttemptRecord(
          routeId: route.id,
          provider: route.provider,
          model: route.model,
          outcome: "capability_mismatch",
          attempts: 0,
          message: rejection,
        ));
        continue;
      }

      if (_isCircuitOpen(route.id)) {
        attempts.add(AttemptRecord(
          routeId: route.id,
          provider: route.provider,
          model: route.model,
          outcome: "circuit_open",
          attempts: 0,
          message: "circuit breaker open",
        ));
        continue;
      }

      if (route.limits.rpm != null) {
        final decision = await _store.take("rpm:${route.id}", 1, windowMs, route.limits.rpm!);
        if (!decision.allowed) {
          attempts.add(AttemptRecord(
            routeId: route.id,
            provider: route.provider,
            model: route.model,
            outcome: "skipped_rate_limit",
            attempts: 0,
            retryAfterMs: decision.retryAfterMs,
          ));
          continue;
        }
      }

      final poolSize = route.keyPool.isNotEmpty ? route.keyPool.length : 1;
      int keyIndex = _health.pickKey(route.id, 0, poolSize) ?? 0;
      int tries = 0;
      final maxTries = route.maxRetries + 1;

      while (tries < maxTries) {
        if (deadline != null && DateTime.now().millisecondsSinceEpoch >= deadline) {
          throw DeadlineExceededError(options!.deadlineMs!);
        }

        final apiKey = route.keyPool.isNotEmpty ? route.keyPool[keyIndex % poolSize] : "";
        final adapter = getAdapter(route.adapterId ?? route.provider);
        final attemptStart = DateTime.now().millisecondsSinceEpoch;
        tries++;

        try {
          final rawStream = await adapter.stream(
            route,
            apiKey,
            validatedReq,
            AdapterContext(client: _client, cancelCompleter: options?.cancelCompleter),
          );

          // STREAMING COMMIT BOUNDARY:
          // Buffer until the first chunk arrives to commit or fallback.
          final streamIterator = StreamIterator(rawStream);
          final hasFirst = await streamIterator.moveNext();

          if (!hasFirst) {
            throw ProviderError(route.provider, ErrorKinds.network, "empty stream body");
          }

          final firstChunk = streamIterator.current;
          final ttfb = (DateTime.now().millisecondsSinceEpoch - attemptStart).toDouble();
          _health.recordSuccess(route.id, ttfbMs: ttfb, op: RouteOpStats.stream);
          _recordCircuitSuccess(route.id);

          options?.onAttempt?.call(AttemptEvent(
            routeId: route.id,
            provider: route.provider,
            model: route.model,
            outcome: AttemptOutcomes.ok,
            attempts: tries,
            keyIndex: keyIndex,
            durationMs: ttfb,
          ));

          // Generator yielding firstChunk followed by the rest
          Stream<ChatChunk> committedGenerator() async* {
            yield firstChunk;
            while (await streamIterator.moveNext()) {
              yield streamIterator.current;
            }
          }

          return committedGenerator();
        } on ProviderError catch (err) {
          _health.recordFailure(
            route.id,
            err.kind,
            keyIndex: keyIndex,
            retryAfterMs: err.retryAfterMs,
            op: RouteOpStats.stream,
          );

          if (tries >= maxTries || !isRetryableKind(err.kind)) {
            _recordCircuitFailure(route.id);
            attempts.add(AttemptRecord(
              routeId: route.id,
              provider: route.provider,
              model: route.model,
              outcome: "error",
              attempts: tries,
              keyIndex: keyIndex,
              kind: err.kind,
              message: err.message,
              retryAfterMs: err.retryAfterMs,
            ));
            break;
          }

          if (isKeyRelatedKind(err.kind) && poolSize > 1) {
            keyIndex = (keyIndex + 1) % poolSize;
          }

          final backoffMs = _backoff(tries - 1, err.retryAfterMs);
          await _sleep(backoffMs);
        } catch (err) {
          _recordCircuitFailure(route.id);
          attempts.add(AttemptRecord(
            routeId: route.id,
            provider: route.provider,
            model: route.model,
            outcome: "error",
            attempts: tries,
            keyIndex: keyIndex,
            message: err.toString(),
          ));
          break;
        }
      }
    }

    throw AllRoutesFailedError(attempts);
  }

  Future<http.Response> raw(
    String routeId,
    RawRequestOptions opts, [
    CallOptions? options,
  ]) async {
    final route = _normalizedRoutes.firstWhere(
      (r) => r.id == routeId,
      orElse: () => throw ConfigError('route "$routeId" not found'),
    );

    if (route.limits.rpm != null) {
      final decision = await _store.take("rpm:${route.id}", 1, windowMs, route.limits.rpm!);
      if (!decision.allowed) {
        throw RateLimitedError(route.id, decision.retryAfterMs);
      }
    }

    final key = route.keyPool.isNotEmpty ? route.keyPool[0] : "";
    final adapter = getAdapter(route.adapterId ?? route.provider);
    return adapter.raw(
      route,
      key,
      opts,
      AdapterContext(client: _client, cancelCompleter: options?.cancelCompleter),
    );
  }

  Future<EmbeddingResponse> embed(EmbeddingRequest req, [CallOptions? options]) async {
    final candidates = _normalizedRoutes.where((r) => r.id == req.model).toList();
    if (candidates.isEmpty) {
      throw ConfigError('route "${req.model}" not found');
    }
    final route = candidates.first;
    final adapter = getAdapter(route.adapterId ?? route.provider);
    final key = route.keyPool.isNotEmpty ? route.keyPool[0] : "";

    return adapter.embed(
      route,
      key,
      req,
      AdapterContext(client: _client, cancelCompleter: options?.cancelCompleter),
    );
  }
}
