class RateLimitDecision {
  final bool allowed;
  final int retryAfterMs;

  const RateLimitDecision({
    required this.allowed,
    required this.retryAfterMs,
  });
}

abstract class RateLimitStore {
  /// Atomic check-and-take.
  Future<RateLimitDecision> take(
    String key,
    int cost,
    int windowMs,
    int limit,
  );

  /// Post-hoc usage recording (e.g. actual token counts reported by provider).
  Future<void> record(
    String key,
    int cost,
    int windowMs,
  );
}
