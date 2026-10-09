/// Error taxonomy. Classification drives the three distinct recovery layers:
///
///   1. retry same route+key      -> isRetryableKind
///   2. rotate key on same route  -> isKeyRelatedKind
///   3. fall back to next route   -> engine always does after a route exhausts

typedef ErrorKind = String;

class ErrorKinds {
  static const String rateLimit = "rate_limit";
  static const String auth = "auth";
  static const String permission = "permission";
  static const String notFound = "not_found";
  static const String invalidRequest = "invalid_request";
  static const String server = "server";
  static const String network = "network";
  static const String timeout = "timeout";
  static const String unknown = "unknown";
}

class AIRouterError implements Exception {
  final String message;
  AIRouterError(this.message);

  @override
  String toString() => "$runtimeType: $message";
}

class ConfigError extends AIRouterError {
  ConfigError(super.message);
}

class UnsupportedProviderError extends AIRouterError {
  UnsupportedProviderError(super.message);
}

/// Thrown when a call exceeds its CallOptions.deadlineMs wall-clock budget.
class DeadlineExceededError extends AIRouterError {
  final int deadlineMs;

  DeadlineExceededError(this.deadlineMs)
      : super("call exceeded its ${deadlineMs}ms deadline");
}

/// Thrown by the raw escape hatch when a route's rpm budget is exhausted.
class RateLimitedError extends AIRouterError {
  final String routeId;
  final int retryAfterMs;

  RateLimitedError(this.routeId, this.retryAfterMs)
      : super('route "$routeId" is rate-limited (retry after ${retryAfterMs}ms)');
}

class ProviderErrorOptions {
  final int? status;
  final int? retryAfterMs;
  final Object? body;
  final Object? cause;

  const ProviderErrorOptions({
    this.status,
    this.retryAfterMs,
    this.body,
    this.cause,
  });
}

class ProviderError extends AIRouterError {
  final String provider;
  final ErrorKind kind;
  final int? status;
  final int? retryAfterMs;
  final Object? body;
  final Object? cause;

  ProviderError(
    this.provider,
    this.kind,
    String message, {
    this.status,
    this.retryAfterMs,
    this.body,
    this.cause,
  }) : super(message);
}

class AttemptRecord {
  final String routeId;
  final String provider;
  final String model;
  final String outcome; // "error" | "skipped_rate_limit" | "skipped_budget" | "circuit_open" | "unsupported" | "capability_mismatch"
  final int attempts;
  final int? keyIndex;
  final ErrorKind? kind;
  final String? message;
  /// Provider-advertised retry delay (Retry-After), when reported.
  final int? retryAfterMs;

  AttemptRecord({
    required this.routeId,
    required this.provider,
    required this.model,
    required this.outcome,
    required this.attempts,
    this.keyIndex,
    this.kind,
    this.message,
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
        if (retryAfterMs != null) "retryAfterMs": retryAfterMs,
      };
}

class AllRoutesFailedError extends AIRouterError {
  final List<AttemptRecord> attempts;
  /// Soonest provider-advertised retry opportunity across the failed routes
  /// (min of Retry-After values). Null when no provider reported one.
  final int? retryAfterMs;

  AllRoutesFailedError(this.attempts)
      : retryAfterMs = _findMinRetryAfter(attempts),
        super("all routes failed (${attempts.length} attempted)");

  static int? _findMinRetryAfter(List<AttemptRecord> attempts) {
    int? minDelay;
    for (final a in attempts) {
      if (a.retryAfterMs != null) {
        if (minDelay == null || a.retryAfterMs! < minDelay) {
          minDelay = a.retryAfterMs;
        }
      }
    }
    return minDelay;
  }
}

ErrorKind classifyStatus(int status) {
  if (status == 400) return ErrorKinds.invalidRequest;
  if (status == 401) return ErrorKinds.auth;
  if (status == 403) return ErrorKinds.permission;
  if (status == 404) return ErrorKinds.notFound;
  if (status == 429) return ErrorKinds.rateLimit;
  if (status >= 500) return ErrorKinds.server;
  return ErrorKinds.unknown;
}

/// Whether the same route+key should be retried with backoff.
bool isRetryableKind(ErrorKind kind) {
  return kind == ErrorKinds.rateLimit ||
      kind == ErrorKinds.server ||
      kind == ErrorKinds.network ||
      kind == ErrorKinds.timeout;
}

/// Whether a different API key on the same route could change the outcome.
bool isKeyRelatedKind(ErrorKind kind) {
  return kind == ErrorKinds.rateLimit ||
      kind == ErrorKinds.auth ||
      kind == ErrorKinds.permission;
}
