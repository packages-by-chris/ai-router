import "dart:math" as math;
import "../errors.dart";

const int ringCapacity = 128;
const int keyCooldownCapMs = 5 * 60 * 1000;
const int defaultHalfLifeMs = 30 * 60 * 1000;
const int defaultSampleTtlMs = 10 * 60 * 1000;

typedef RouteOpStat = String;

class RouteOpStats {
  static const String complete = "complete";
  static const String stream = "stream";
}

class KeyHealth {
  final int keyIndex;
  final int failures;
  final int cooldownRemainingMs;

  const KeyHealth({
    required this.keyIndex,
    required this.failures,
    required this.cooldownRemainingMs,
  });

  Map<String, dynamic> toJson() => {
        "keyIndex": keyIndex,
        "failures": failures,
        "cooldownRemainingMs": cooldownRemainingMs,
      };
}

class OpLatencyPercentiles {
  final double? p50Ms;
  final double? p95Ms;
  final double? p99Ms;
  final int samples;
  final OpLatencyPercentiles? ttfb;

  const OpLatencyPercentiles({
    this.p50Ms,
    this.p95Ms,
    this.p99Ms,
    required this.samples,
    this.ttfb,
  });

  Map<String, dynamic> toJson() => {
        if (p50Ms != null) "p50Ms": p50Ms,
        if (p95Ms != null) "p95Ms": p95Ms,
        if (p99Ms != null) "p99Ms": p99Ms,
        "samples": samples,
        if (ttfb != null) "ttfb": ttfb!.toJson(),
      };
}

class RouteHealthSnapshot {
  final String routeId;
  final int successes;
  final int failures;
  final Map<ErrorKind, int> byKind;
  final double successRate;
  final double? p50LatencyMs;
  final double? p95LatencyMs;
  final double? p99LatencyMs;
  final double? p50TtfbMs;
  final double? p95TtfbMs;
  final double? p99TtfbMs;
  final List<KeyHealth> keys;
  final double? successLb;
  final double? timeoutRate;
  final OpLatencyPercentiles? complete;
  final OpLatencyPercentiles? stream;
  final double? costRatio;

  const RouteHealthSnapshot({
    required this.routeId,
    required this.successes,
    required this.failures,
    required this.byKind,
    required this.successRate,
    this.p50LatencyMs,
    this.p95LatencyMs,
    this.p99LatencyMs,
    this.p50TtfbMs,
    this.p95TtfbMs,
    this.p99TtfbMs,
    required this.keys,
    this.successLb,
    this.timeoutRate,
    this.complete,
    this.stream,
    this.costRatio,
  });

  Map<String, dynamic> toJson() => {
        "routeId": routeId,
        "successes": successes,
        "failures": failures,
        "byKind": byKind,
        "successRate": successRate,
        if (p50LatencyMs != null) "p50LatencyMs": p50LatencyMs,
        if (p95LatencyMs != null) "p95LatencyMs": p95LatencyMs,
        if (p99LatencyMs != null) "p99LatencyMs": p99LatencyMs,
        if (p50TtfbMs != null) "p50TtfbMs": p50TtfbMs,
        if (p95TtfbMs != null) "p95TtfbMs": p95TtfbMs,
        if (p99TtfbMs != null) "p99TtfbMs": p99TtfbMs,
        "keys": keys.map((k) => k.toJson()).toList(),
        if (successLb != null) "successLb": successLb,
        if (timeoutRate != null) "timeoutRate": timeoutRate,
        if (complete != null) "complete": complete!.toJson(),
        if (stream != null) "stream": stream!.toJson(),
        if (costRatio != null) "costRatio": costRatio,
      };
}

class _TimedRing {
  final List<double> buf = List.filled(ringCapacity, 0.0);
  final List<int> ts = List.filled(ringCapacity, 0);
  int size = 0;
  int head = 0;

  void push(double value, int now) {
    buf[head] = value;
    ts[head] = now;
    head = (head + 1) % ringCapacity;
    if (size < ringCapacity) size++;
  }

  List<double> collectWithin(int now, int ttl) {
    final out = <double>[];
    for (int i = 0; i < size; i++) {
      final idx = (head - 1 - i + ringCapacity) % ringCapacity;
      if (ttl > 0 && now - ts[idx] > ttl) break;
      out.add(buf[idx]);
    }
    return out;
  }
}

double? _percentileOf(List<double> values, double p) {
  if (values.isEmpty) return null;
  final sorted = List<double>.from(values)..sort();
  final idx = (p * sorted.length).ceil() - 1;
  final clampedIdx = idx.clamp(0, sorted.length - 1);
  return (sorted[clampedIdx] * 100).round() / 100;
}

class _OpStat {
  final _TimedRing lat = _TimedRing();
  final _TimedRing ttfb = _TimedRing();
}

class _KindTally {
  int n = 0;
  double w = 0.0;
}

class _KeyState {
  int failures = 0;
  int cooldownUntil = 0;
}

class _RouteState {
  int successes = 0;
  int failures = 0;
  final Map<ErrorKind, _KindTally> byKind = {};
  double successRateEma = 1.0;
  double succW = 0.0;
  double failW = 0.0;
  int succLastAt;
  final _OpStat completeOp = _OpStat();
  final _OpStat streamOp = _OpStat();
  final Map<int, _KeyState> keys = {};
  double? costRatioEma;
  int? costRatioLastAt;

  _RouteState(this.succLastAt);

  _OpStat getOp(RouteOpStat op) => op == RouteOpStats.stream ? streamOp : completeOp;
}

const double _successEmaAlpha = 0.3;
const double _wilsonZ = 1.96;

double? wilsonLowerBound(double successes, double total) {
  if (total <= 0) return null;
  final p = successes / total;
  const z2 = _wilsonZ * _wilsonZ;
  final n = total;
  final denom = 1 + z2 / n;
  final centre = p + z2 / (2 * n);
  final spread = _wilsonZ * math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  final score = (centre - spread) / denom;
  return score.clamp(0.0, 1.0);
}

class HealthTracker {
  final Map<String, _RouteState> _routes = {};
  final int halfLifeMs;
  final int sampleTtlMs;

  HealthTracker({
    this.halfLifeMs = defaultHalfLifeMs,
    this.sampleTtlMs = defaultSampleTtlMs,
  });

  void recordSuccess(
    String routeId, {
    double? latencyMs,
    double? ttfbMs,
    RouteOpStat op = RouteOpStats.complete,
  }) {
    final now = DateTime.now().millisecondsSinceEpoch;
    final s = _stateFor(routeId, now);
    s.successes++;
    _decayCounts(s, now);
    s.succW += 1.0;
    s.successRateEma += (1.0 - s.successRateEma) * _successEmaAlpha;
    final opStat = s.getOp(op);
    if (latencyMs != null) opStat.lat.push(latencyMs, now);
    if (ttfbMs != null) opStat.ttfb.push(ttfbMs, now);
  }

  void recordFailure(
    String routeId,
    ErrorKind kind, {
    int? keyIndex,
    int? retryAfterMs,
    double? latencyMs,
    RouteOpStat op = RouteOpStats.complete,
  }) {
    final now = DateTime.now().millisecondsSinceEpoch;
    final s = _stateFor(routeId, now);
    s.failures++;
    _decayCounts(s, now);
    s.failW += 1.0;
    final tally = s.byKind.putIfAbsent(kind, () => _KindTally());
    tally.n += 1;
    tally.w += 1.0;
    s.successRateEma -= s.successRateEma * _successEmaAlpha;

    if (latencyMs != null && (kind == ErrorKinds.timeout || kind == ErrorKinds.network)) {
      s.getOp(op).lat.push(latencyMs, now);
    }
    if (keyIndex != null) {
      final key = s.keys.putIfAbsent(keyIndex, () => _KeyState());
      key.failures++;
      if (retryAfterMs != null &&
          (kind == ErrorKinds.rateLimit || kind == ErrorKinds.auth || kind == ErrorKinds.permission)) {
        key.cooldownUntil = now + math.min(retryAfterMs, keyCooldownCapMs);
      }
    }
  }

  void recordCostRatio(String routeId, double ratio) {
    final now = DateTime.now().millisecondsSinceEpoch;
    final s = _stateFor(routeId, now);
    final clamped = ratio.clamp(0.01, 100.0);
    _decayCost(s, now);
    s.costRatioEma = s.costRatioEma == null ? clamped : s.costRatioEma! * 0.7 + clamped * 0.3;
    s.costRatioLastAt = now;
  }

  double? costRatio(String routeId) {
    final s = _routes[routeId];
    if (s == null || s.costRatioEma == null) return null;
    return _decayedCostRatio(s, DateTime.now().millisecondsSinceEpoch);
  }

  int? pickKey(String routeId, int start, int poolSize) {
    final s = _routes[routeId];
    final now = DateTime.now().millisecondsSinceEpoch;
    for (int i = 0; i < poolSize; i++) {
      final idx = (start + i) % poolSize;
      final key = s?.keys[idx];
      if (key == null || now >= key.cooldownUntil) return idx;
    }
    return null;
  }

  bool keyOnCooldown(String routeId, int keyIndex) {
    final key = _routes[routeId]?.keys[keyIndex];
    return key != null && key.cooldownUntil != 0 && DateTime.now().millisecondsSinceEpoch < key.cooldownUntil;
  }

  double? medianLatency(String routeId, [RouteOpStat? op]) {
    return latencyPercentile(routeId, 0.5, op);
  }

  double? latencyPercentile(String routeId, double p, [RouteOpStat? op]) {
    final s = _routes[routeId];
    if (s == null) return null;
    final now = DateTime.now().millisecondsSinceEpoch;
    final rings = op == null ? [s.completeOp.lat, s.streamOp.lat] : [s.getOp(op).lat];
    final values = rings.expand((r) => r.collectWithin(now, sampleTtlMs)).toList();
    return _percentileOf(values, p);
  }

  double? successLb(String routeId) {
    final s = _routes[routeId];
    if (s == null) return null;
    _decayCounts(s, DateTime.now().millisecondsSinceEpoch);
    return wilsonLowerBound(s.succW, s.succW + s.failW);
  }

  List<RouteHealthSnapshot> snapshot() {
    final out = <RouteHealthSnapshot>[];
    final now = DateTime.now().millisecondsSinceEpoch;
    for (final entry in _routes.entries) {
      final routeId = entry.key;
      final s = entry.value;
      final byKind = <ErrorKind, int>{};
      for (final k in s.byKind.entries) {
        byKind[k.key] = k.value.n;
      }
      _decayCounts(s, now);

      final allLat = [
        ...s.completeOp.lat.collectWithin(now, sampleTtlMs),
        ...s.streamOp.lat.collectWithin(now, sampleTtlMs),
      ];
      final allTtfb = [
        ...s.completeOp.ttfb.collectWithin(now, sampleTtlMs),
        ...s.streamOp.ttfb.collectWithin(now, sampleTtlMs),
      ];
      final keys = s.keys.entries.map((k) {
        final rem = k.value.cooldownUntil > now ? k.value.cooldownUntil - now : 0;
        return KeyHealth(
          keyIndex: k.key,
          failures: k.value.failures,
          cooldownRemainingMs: rem,
        );
      }).toList();

      final totalFailW = s.failW;
      final timeoutW = s.byKind[ErrorKinds.timeout]?.w ?? 0.0;
      final timeoutRate = totalFailW > 0 && timeoutW > 0 ? timeoutW / totalFailW : null;

      out.add(RouteHealthSnapshot(
        routeId: routeId,
        successes: s.successes,
        failures: s.failures,
        byKind: byKind,
        successRate: (s.successRateEma * 10000).round() / 10000,
        p50LatencyMs: _percentileOf(allLat, 0.5),
        p95LatencyMs: _percentileOf(allLat, 0.95),
        p99LatencyMs: _percentileOf(allLat, 0.99),
        p50TtfbMs: _percentileOf(allTtfb, 0.5),
        p95TtfbMs: _percentileOf(allTtfb, 0.95),
        p99TtfbMs: _percentileOf(allTtfb, 0.99),
        keys: keys,
        successLb: wilsonLowerBound(s.succW, s.succW + s.failW),
        timeoutRate: timeoutRate,
        costRatio: s.costRatioEma != null ? _decayedCostRatio(s, now) : null,
      ));
    }
    return out;
  }

  _RouteState _stateFor(String routeId, int now) {
    return _routes.putIfAbsent(routeId, () => _RouteState(now));
  }

  void _decayCounts(_RouteState s, int now) {
    if (halfLifeMs <= 0) return;
    final elapsed = now - s.succLastAt;
    if (elapsed <= 0) return;
    final d = math.pow(0.5, elapsed / halfLifeMs).toDouble();
    s.succW *= d;
    s.failW *= d;
    for (final v in s.byKind.values) {
      v.w *= d;
    }
    const neutral = 0.5;
    s.successRateEma = neutral + (s.successRateEma - neutral) * d;
    s.succLastAt = now;
  }

  void _decayCost(_RouteState s, int now) {
    if (halfLifeMs <= 0 || s.costRatioEma == null || s.costRatioLastAt == null) return;
    final elapsed = now - s.costRatioLastAt!;
    if (elapsed <= 0) return;
    final d = math.pow(0.5, elapsed / halfLifeMs).toDouble();
    s.costRatioEma = 1.0 + (s.costRatioEma! - 1.0) * d;
    s.costRatioLastAt = now;
  }

  double? _decayedCostRatio(_RouteState s, int now) {
    if (s.costRatioEma == null) return null;
    if (halfLifeMs <= 0 || s.costRatioLastAt == null) return s.costRatioEma;
    final d = math.pow(0.5, (now - s.costRatioLastAt!) / halfLifeMs).toDouble();
    return 1.0 + (s.costRatioEma! - 1.0) * d;
  }
}
