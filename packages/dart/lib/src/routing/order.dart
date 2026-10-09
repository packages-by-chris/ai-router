import "dart:math" as math;
import "../config/schema.dart";
import "../providers/types.dart";
import "../types.dart";
import "health.dart";
import "outcomes.dart";

double estimateCostUsd(TokenPrice price, int inputTokens, [int? maxTokens]) {
  final outputTokens = maxTokens ?? inputTokens;
  final usd = (inputTokens / 1000000.0) * price.input +
      (outputTokens / 1000000.0) * price.output;
  return (usd * 1e6).round() / 1e6;
}

TokenPrice? priceLookup(
  Map<String, TokenPrice>? pricing,
  String routeId,
  String model,
) {
  if (pricing == null) return null;
  return pricing[routeId] ?? pricing[model];
}

List<double> _rankValues(List<double?> values, String dir) {
  final known = values.whereType<double>().toList();
  if (known.isEmpty) return List.filled(values.length, 0.5);

  return values.map((v) {
    if (v == null) return 0.5;
    if (known.length == 1) return 1.0;
    final better = known.where((k) => dir == "asc" ? k < v : k > v).length;
    return 1.0 - better / (known.length - 1);
  }).toList();
}

List<double?> shrinkLatencies(
  List<double?> values,
  List<int?> counts, [
  int shrinkK = 3,
]) {
  final solid = <double>[];
  for (int i = 0; i < values.length; i++) {
    final v = values[i];
    final count = counts[i] ?? 0;
    if (v != null && count >= shrinkK) {
      solid.add(v);
    }
  }

  if (solid.isEmpty) return List<double?>.from(values);
  final anchor = solid.reduce(math.min);

  return values.asMap().entries.map((e) {
    final i = e.key;
    final v = e.value;
    if (v == null) return null;
    final n = counts[i] ?? 0;
    if (n >= shrinkK || shrinkK <= 0) return v;
    return (n * v + (shrinkK - n) * anchor) / shrinkK;
  }).toList();
}

class PolicySignals {
  final List<double?> estCosts;
  final List<double?> latencies;
  final List<double?>? successScores;
  final List<double?>? qualities;
  final PolicyWeights? weights;

  const PolicySignals({
    required this.estCosts,
    required this.latencies,
    this.successScores,
    this.qualities,
    this.weights,
  });
}

class ScoreBreakdown {
  final double cost;
  final double speed;
  final double reliability;
  final double total;

  const ScoreBreakdown({
    required this.cost,
    required this.speed,
    required this.reliability,
    required this.total,
  });

  Map<String, dynamic> toJson() => {
        "cost": cost,
        "speed": speed,
        "reliability": reliability,
        "total": total,
      };
}

(double, double, double) _normalizeWeights(PolicyWeights? w) {
  final cost = w?.cost ?? 0.5;
  final speed = w?.speed ?? 0.3;
  final rel = w?.reliability ?? 0.2;
  final total = cost + speed + rel;
  if (total <= 0) return (0.5, 0.3, 0.2);
  return (cost / total, speed / total, rel / total);
}

List<double> balancedScores(PolicySignals signals) {
  final (wCost, wSpeed, wRel) = _normalizeWeights(signals.weights);
  final costScore = _rankValues(signals.estCosts, "asc");
  final speedScore = _rankValues(signals.latencies, "asc");

  final qualityInput = signals.qualities ?? [];
  final anyQuality = qualityInput.any((q) => q != null);
  final reliabilitySource = anyQuality ? qualityInput : (signals.successScores ?? []);

  final relRank = _rankValues(reliabilitySource, "desc").asMap().entries.map((e) {
    final i = e.key;
    final v = e.value;
    if (i < reliabilitySource.length && reliabilitySource[i] == null && anyQuality) {
      return 0.5;
    }
    return v;
  }).toList();

  final out = <double>[];
  for (int i = 0; i < costScore.length; i++) {
    final relVal = i < relRank.length ? relRank[i] : 0.5;
    out.add(wCost * costScore[i] + wSpeed * speedScore[i] + wRel * relVal);
  }
  return out;
}

List<int> orderByScore(List<double> scores) {
  final withIdx = scores.asMap().entries.map((e) => (idx: e.key, score: e.value)).toList();
  withIdx.sort((a, b) {
    final cmp = b.score.compareTo(a.score);
    if (cmp != 0) return cmp;
    return a.idx.compareTo(b.idx);
  });
  return withIdx.map((x) => x.idx).toList();
}

class ArrangeContext {
  final RoutingStrategy? strategy;
  final RouteOpStat op;
  final String? task;
  final double Function() rng;
  final int rrCounter;
  final HealthTracker health;
  final OutcomeTracker outcomes;
  final int Function(ChatRequest req) estimateTokensFn;
  final Map<String, TokenPrice>? pricing;
  final PolicyWeights? weights;
  final ChatRequest req;
  final List<NormalizedRoute> chain;

  const ArrangeContext({
    this.strategy,
    required this.op,
    this.task,
    required this.rng,
    required this.rrCounter,
    required this.health,
    required this.outcomes,
    required this.estimateTokensFn,
    this.pricing,
    this.weights,
    required this.req,
    required this.chain,
  });
}

class ArrangeResult {
  final List<NormalizedRoute> chain;
  final List<ScoreBreakdown?>? breakdowns;
  final bool explored;

  const ArrangeResult({
    required this.chain,
    this.breakdowns,
    this.explored = false,
  });
}

ArrangeResult arrangeChain(ArrangeContext ctx) {
  final chain = List<NormalizedRoute>.from(ctx.chain);
  if (chain.length <= 1) return ArrangeResult(chain: chain);

  if (ctx.strategy == RoutingStrategies.roundRobin) {
    final offset = ctx.rrCounter % chain.length;
    if (offset > 0) {
      final head = chain.sublist(0, offset);
      chain.removeRange(0, offset);
      chain.addAll(head);
    }
    return ArrangeResult(chain: chain);
  }

  if (ctx.strategy == RoutingStrategies.weighted) {
    final weights = chain.map((r) => (r.weight != null && r.weight! > 0) ? r.weight! : 1.0).toList();
    final total = weights.reduce((a, b) => a + b);
    double pick = ctx.rng() * total;
    int offset = 0;
    for (int i = 0; i < weights.length; i++) {
      pick -= weights[i];
      if (pick <= 0) {
        offset = i;
        break;
      }
    }
    if (offset > 0) {
      final head = chain.sublist(0, offset);
      chain.removeRange(0, offset);
      chain.addAll(head);
    }
    return ArrangeResult(chain: chain);
  }

  if (ctx.strategy == RoutingStrategies.leastLatency) {
    final withIdx = chain.asMap().entries.map((e) {
      return (
        route: e.value,
        i: e.key,
        ema: ctx.health.medianLatency(e.value.id, ctx.op),
      );
    }).toList();

    withIdx.sort((a, b) {
      if (a.ema != null && b.ema != null) return a.ema!.compareTo(b.ema!);
      if (a.ema == null && b.ema != null) return -1;
      if (b.ema == null && a.ema != null) return 1;
      return a.i.compareTo(b.i);
    });

    return ArrangeResult(chain: withIdx.map((x) => x.route).toList());
  }

  if (ctx.strategy == RoutingStrategies.cheapest ||
      ctx.strategy == RoutingStrategies.balanced ||
      ctx.strategy == RoutingStrategies.qualityFirst) {
    return _policyOrder(ctx, chain);
  }

  return ArrangeResult(chain: chain);
}

ArrangeResult _policyOrder(ArrangeContext ctx, List<NormalizedRoute> chain) {
  final inputTokens = ctx.estimateTokensFn(ctx.req);
  final snapshots = ctx.health.snapshot();
  final byId = {for (final h in snapshots) h.routeId: h};

  final estCosts = chain.map((route) {
    final price = priceLookup(ctx.pricing, route.id, route.model);
    if (price == null) return null;
    final est = estimateCostUsd(price, inputTokens, ctx.req.maxTokens);
    final ratio = ctx.health.costRatio(route.id) ?? 1.0;
    return ((est * ratio * 1e6).round() / 1e6);
  }).toList();

  final rawLatencies = chain.map((route) {
    return byId[route.id]?.p50LatencyMs ?? ctx.health.medianLatency(route.id, ctx.op);
  }).toList();

  final sampleCounts = chain.map((route) {
    final h = byId[route.id];
    if (h == null) return null;
    final total = (h.complete?.samples ?? 0) + (h.stream?.samples ?? 0);
    return total > 0 ? total : null;
  }).toList();

  final latencies = shrinkLatencies(rawLatencies, sampleCounts);

  final successRates = chain.map((route) {
    final h = byId[route.id];
    if (h == null || (h.successes + h.failures == 0)) return null;
    return h.successLb ?? h.successRate;
  }).toList();

  final successScores = chain.asMap().entries.map((e) {
    final i = e.key;
    final s = successRates[i];
    if (s == null) return null;
    final tr = byId[e.value.id]?.timeoutRate;
    return tr == null ? s : s * (1.0 - 0.25 * tr);
  }).toList();

  if (ctx.strategy == RoutingStrategies.cheapest) {
    final idx = List.generate(chain.length, (i) => i);
    idx.sort((a, b) {
      final ca = estCosts[a];
      final cb = estCosts[b];
      if (ca != null && cb != null) return ca.compareTo(cb);
      if (ca != null) return -1;
      if (cb != null) return 1;
      return a.compareTo(b);
    });
    final ordered = idx.map((i) => chain[i]).toList();
    return ArrangeResult(
      chain: ordered,
      breakdowns: idx.map((i) => estCosts[i] == null
          ? null
          : const ScoreBreakdown(cost: 1, speed: 0, reliability: 0, total: 1)).toList(),
    );
  }

  final qualities = ctx.strategy == RoutingStrategies.balanced
      ? List<double?>.filled(chain.length, null)
      : chain.map((route) => ctx.outcomes.quality(ctx.task, route.id)).toList();

  final signals = PolicySignals(
    estCosts: estCosts,
    latencies: latencies,
    successScores: successScores,
    qualities: qualities,
    weights: ctx.weights,
  );
  final scores = balancedScores(signals);
  final order = orderByScore(scores);

  final (wCost, wSpeed, wRel) = _normalizeWeights(ctx.weights);
  final costRank = _rankValues(estCosts, "asc");
  final speedRank = _rankValues(latencies, "asc");
  final anyQuality = qualities.any((q) => q != null);
  final relSource = anyQuality ? qualities : successScores;
  final relRank = _rankValues(relSource, "desc").asMap().entries.map((e) {
    final i = e.key;
    final v = e.value;
    if (i < relSource.length && relSource[i] == null && anyQuality) return 0.5;
    return v;
  }).toList();

  final breakdowns = order.map((originalIdx) {
    final c = ((wCost * costRank[originalIdx] * 1e6).round() / 1e6);
    final s = ((wSpeed * speedRank[originalIdx] * 1e6).round() / 1e6);
    final r = ((wRel * relRank[originalIdx] * 1e6).round() / 1e6);
    final t = ((scores[originalIdx] * 1e6).round() / 1e6);
    return ScoreBreakdown(cost: c, speed: s, reliability: r, total: t);
  }).toList();

  return ArrangeResult(
    chain: order.map((i) => chain[i]).toList(),
    breakdowns: breakdowns,
  );
}
