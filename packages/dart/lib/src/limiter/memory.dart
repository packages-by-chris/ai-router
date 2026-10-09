import "store.dart";

class _Entry {
  final int ts;
  final int cost;
  _Entry(this.ts, this.cost);
}

/// Sliding-window log, in-process. Entries are [timestamp, cost] pairs;
/// the window cost is the sum of entries newer than windowMs.
class MemoryStore implements RateLimitStore {
  final Map<String, List<_Entry>> _entries = {};
  final int Function() _now;
  int _calls = 0;
  final int _pruneInterval;

  MemoryStore({
    int Function()? now,
    int pruneInterval = 1000,
  })  : _now = now ?? (() => DateTime.now().millisecondsSinceEpoch),
        _pruneInterval = pruneInterval;

  @override
  Future<RateLimitDecision> take(
    String key,
    int cost,
    int windowMs,
    int limit,
  ) async {
    _maybePruneAll(windowMs);
    final list = _prune(key, windowMs);
    final used = list.fold<int>(0, (sum, e) => sum + e.cost);
    if (used + cost <= limit) {
      list.add(_Entry(_now(), cost));
      return const RateLimitDecision(allowed: true, retryAfterMs: 0);
    }
    final oldest = list.isNotEmpty ? list.first : null;
    final retryAfterMs = oldest != null
        ? ((oldest.ts + windowMs - _now()) > 1 ? (oldest.ts + windowMs - _now()) : 1)
        : 1;
    return RateLimitDecision(allowed: false, retryAfterMs: retryAfterMs);
  }

  @override
  Future<void> record(String key, int cost, int windowMs) async {
    _maybePruneAll(windowMs);
    final list = _prune(key, windowMs);
    list.add(_Entry(_now(), cost));
  }

  int used(String key, int windowMs) {
    final list = _prune(key, windowMs);
    return list.fold<int>(0, (sum, e) => sum + e.cost);
  }

  Map<String, int> snapshot() {
    final out = <String, int>{};
    for (final entry in _entries.entries) {
      if (entry.value.isEmpty) continue;
      out[entry.key] = entry.value.fold<int>(0, (sum, e) => sum + e.cost);
    }
    return out;
  }

  void _maybePruneAll(int windowMs) {
    _calls++;
    if (_calls < _pruneInterval) return;
    _calls = 0;
    final cutoff = _now() - windowMs;
    final keysToRemove = <String>[];
    for (final entry in _entries.entries) {
      entry.value.removeWhere((e) => e.ts <= cutoff);
      if (entry.value.isEmpty) {
        keysToRemove.add(entry.key);
      }
    }
    for (final k in keysToRemove) {
      _entries.remove(k);
    }
  }

  List<_Entry> _prune(String key, int windowMs) {
    final list = _entries.putIfAbsent(key, () => <_Entry>[]);
    final cutoff = _now() - windowMs;
    list.removeWhere((e) => e.ts <= cutoff);
    return list;
  }
}
