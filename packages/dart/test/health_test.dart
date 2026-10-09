import "package:ai_router/ai_router.dart";
import "package:test/test.dart";

void main() {
  group("HealthTracker", () {
    test("tracks successes and latencies", () {
      final tracker = HealthTracker();

      tracker.recordSuccess("routeA", latencyMs: 120.0);
      tracker.recordSuccess("routeA", latencyMs: 140.0);
      tracker.recordSuccess("routeA", latencyMs: 160.0);

      expect(tracker.medianLatency("routeA"), equals(140.0));
      expect(tracker.successLb("routeA"), isNotNull);
    });

    test("cooldowns keys on rate limit failures", () {
      final tracker = HealthTracker();

      tracker.recordFailure(
        "routeB",
        ErrorKinds.rateLimit,
        keyIndex: 0,
        retryAfterMs: 5000,
      );

      expect(tracker.keyOnCooldown("routeB", 0), isTrue);
      expect(tracker.keyOnCooldown("routeB", 1), isFalse);

      // pickKey skips key 0 and chooses key 1
      final chosen = tracker.pickKey("routeB", 0, 2);
      expect(chosen, equals(1));
    });

    test("wilson lower bound produces conservative estimates under uncertainty", () {
      final lbFew = wilsonLowerBound(3, 3);
      final lbMany = wilsonLowerBound(30, 30);

      expect(lbFew, isNotNull);
      expect(lbMany, isNotNull);
      // 30/30 should have higher lower-bound confidence than 3/3
      expect(lbMany!, greaterThan(lbFew!));
    });
  });
}
