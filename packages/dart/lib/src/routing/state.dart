import "../types.dart";

const String defaultStateKey = "ai-router:state";

String? inferTask(ChatRequest req) {
  for (final m in req.messages) {
    if (m.role == Roles.system && m.content is String) {
      final str = m.content as String;
      final match = RegExp(r"task:\s*([a-zA-Z0-9_-]+)", caseSensitive: false).firstMatch(str);
      if (match != null) return match.group(1);
    }
  }
  return null;
}

abstract class RouterStateStore {
  Future<void> save(String key, Object? data);
  Future<Object?> load(String key);
}
