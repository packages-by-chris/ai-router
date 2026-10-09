import "dart:math" as math;

class OutcomeEvent {
  final String routeId;
  final String? task;
  final bool? success;
  final double? quality;
  final double? latencyMs;
  final double? costUsd;

  const OutcomeEvent({
    required this.routeId,
    this.task,
    this.success,
    this.quality,
    this.latencyMs,
    this.costUsd,
  });
}

class OutcomeStats {
  final String routeId;
  final String task;
  final int samples;
  final double successRate;
  final double? avgQuality;
  final double? avgLatencyMs;
  final double? avgCostUsd;

  const OutcomeStats({
    required this.routeId,
    required this.task,
    required this.samples,
    required this.successRate,
    this.avgQuality,
    this.avgLatencyMs,
    this.avgCostUsd,
  });

  Map<String, dynamic> toJson() => {
        "routeId": routeId,
        "task": task,
        "samples": samples,
        "successRate": successRate,
        if (avgQuality != null) "avgQuality": avgQuality,
        if (avgLatencyMs != null) "avgLatencyMs": avgLatencyMs,
        if (avgCostUsd != null) "avgCostUsd": avgCostUsd,
      };
}

class _Bucket {
  int samples = 0;
  double successRateEma = 1.0;
  double? qualityEma;
  double? latencyEma;
  double? costEma;
  int lastAt;

  _Bucket(this.lastAt);
}

const double _alphaDefault = 0.3;
const int _halfLifeDefault = 30 * 60 * 1000;
const double _neutral = 0.5;

double _ema(double? prev, double value, double alpha) {
  return prev == null ? value : prev * (1.0 - alpha) + value * alpha;
}

class OutcomeTracker {
  final Map<String, _Bucket> _buckets = {};
  final double alpha;
  final int halfLifeMs;

  OutcomeTracker({
    double alpha = _alphaDefault,
    this.halfLifeMs = _halfLifeDefault,
  }) : alpha = alpha.clamp(0.001, 1.0);

  void record(OutcomeEvent event) {
    if (!RegExp(r"^[a-zA-Z0-9_.-]*$").hasMatch(event.routeId)) return;
    if (event.quality != null && (event.quality! < 0 || event.quality! > 1)) return;

    final now = DateTime.now().millisecondsSinceEpoch;
    final key = "${event.task ?? ""}|${event.routeId}";
    final b = _buckets.putIfAbsent(key, () => _Bucket(now));
    _decay(b, now);

    b.samples++;
    b.successRateEma = _ema(b.successRateEma, event.success == false ? 0.0 : 1.0, alpha);
    if (event.quality != null) {
      b.qualityEma = _ema(b.qualityEma, event.quality!, alpha);
    }
    if (event.latencyMs != null) {
      b.latencyEma = _ema(b.latencyEma, event.latencyMs!, alpha);
    }
    if (event.costUsd != null) {
      b.costEma = _ema(b.costEma, event.costUsd!, alpha);
    }
    b.lastAt = now;
  }

  double? quality(String? task, String routeId) {
    final b = _buckets["${task ?? ""}|$routeId"];
    if (b == null || b.qualityEma == null) return null;
    final now = DateTime.now().millisecondsSinceEpoch;
    final copy = _Bucket(b.lastAt)
      ..samples = b.samples
      ..successRateEma = b.successRateEma
      ..qualityEma = b.qualityEma
      ..latencyEma = b.latencyEma
      ..costEma = b.costEma;
    _decay(copy, now);
    return copy.qualityEma;
  }

  List<OutcomeStats> snapshot() {
    final now = DateTime.now().millisecondsSinceEpoch;
    final out = <OutcomeStats>[];
    for (final entry in _buckets.entries) {
      final sep = entry.key.indexOf("|");
      final task = entry.key.substring(0, sep);
      final routeId = entry.key.substring(sep + 1);
      final b = _Bucket(entry.value.lastAt)
        ..samples = entry.value.samples
        ..successRateEma = entry.value.successRateEma
        ..qualityEma = entry.value.qualityEma
        ..latencyEma = entry.value.latencyEma
        ..costEma = entry.value.costEma;
      _decay(b, now);

      out.add(OutcomeStats(
        routeId: routeId,
        task: task,
        samples: b.samples,
        successRate: (b.successRateEma * 1e6).round() / 1e6,
        avgQuality: b.qualityEma != null ? (b.qualityEma! * 1e6).round() / 1e6 : null,
        avgLatencyMs: b.latencyEma != null ? (b.latencyEma! * 1e6).round() / 1e6 : null,
        avgCostUsd: b.costEma != null ? (b.costEma! * 1e6).round() / 1e6 : null,
      ));
    }
    return out;
  }

  void _decay(_Bucket b, int now) {
    if (halfLifeMs <= 0) return;
    final elapsed = now - b.lastAt;
    if (elapsed <= 0) return;
    final d = math.pow(0.5, elapsed / halfLifeMs).toDouble();
    b.successRateEma = _neutral + (b.successRateEma - _neutral) * d;
    if (b.qualityEma != null) {
      b.qualityEma = _neutral + (b.qualityEma! - _neutral) * d;
    }
  }
}
