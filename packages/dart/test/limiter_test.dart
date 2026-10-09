import "package:ai_router/ai_router.dart";
import "package:test/test.dart";

void main() {
  group("MemoryStore", () {
    test("sliding window rate limiting permits within limit and blocks on excess", () async {
      int simulatedTime = 100000;
      final store = MemoryStore(now: () => simulatedTime);

      final d1 = await store.take("rpm:fast", 1, 60000, 2);
      expect(d1.allowed, isTrue);

      final d2 = await store.take("rpm:fast", 1, 60000, 2);
      expect(d2.allowed, isTrue);

      final d3 = await store.take("rpm:fast", 1, 60000, 2);
      expect(d3.allowed, isFalse);
      expect(d3.retryAfterMs, equals(60000));

      // Advance time by 60001 ms -> window slides, new token available
      simulatedTime += 60001;
      final d4 = await store.take("rpm:fast", 1, 60000, 2);
      expect(d4.allowed, isTrue);
    });

    test("record tracks post-hoc token usage", () async {
      int simulatedTime = 100000;
      final store = MemoryStore(now: () => simulatedTime);

      await store.record("tpm:route1", 500, 60000);
      await store.record("tpm:route1", 700, 60000);

      expect(store.used("tpm:route1", 60000), equals(1200));

      // Advance time
      simulatedTime += 60001;
      expect(store.used("tpm:route1", 60000), equals(0));
    });
  });
}
