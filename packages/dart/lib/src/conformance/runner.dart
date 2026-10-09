import "dart:async";
import "dart:convert";
import "../http/sse.dart";
import "../providers/anthropic.dart" as anthropic;
import "../providers/bedrock.dart" as bedrock;
import "../providers/gemini.dart" as gemini;
import "../providers/openai.dart" as openai;
import "../types.dart";

Object? _toPlain(Object? val) {
  if (val == null) return null;
  if (val is ChatRequest) return _toPlain(val.toJson());
  if (val is ChatResponse) return _toPlain(val.toJson());
  if (val is ChatChunk) return _toPlain(val.toJson());
  if (val is ChatMessage) return _toPlain(val.toJson());
  if (val is Choice) return _toPlain(val.toJson());
  if (val is Usage) return _toPlain(val.toJson());
  if (val is Tool) return _toPlain(val.toJson());
  if (val is ToolCall) return _toPlain(val.toJson());
  if (val is ToolCallDelta) return _toPlain(val.toJson());
  if (val is Delta) return _toPlain(val.toJson());
  if (val is ContentPart) return _toPlain(val.toJson());
  if (val is ResponseFormat) return _toPlain(val.toJson());

  if (val is Map) {
    final sortedKeys = val.keys.map((k) => k.toString()).toList()..sort();
    final out = <String, dynamic>{};
    for (final k in sortedKeys) {
      final v = _toPlain(val[k]);
      if (v != null) {
        out[k] = v;
      }
    }
    return out;
  }
  if (val is List) {
    return val.map(_toPlain).toList();
  }
  return val;
}

String stableJson(Object? value) {
  final plain = _toPlain(value);
  return jsonEncode(plain);
}

class CaseResult {
  final String name;
  final bool ok;
  final String? expected;
  final String? actual;

  const CaseResult({
    required this.name,
    required this.ok,
    this.expected,
    this.actual,
  });
}

typedef TranslationHandler = FutureOr<Object?> Function(Map<String, dynamic> input);

final Map<String, TranslationHandler> builtinHandlers = {
  "openai_request": (inp) {
    final reqJson = inp["request"] is Map ? Map<String, dynamic>.from(inp["request"] as Map) : <String, dynamic>{};
    final req = ChatRequest.fromJson(reqJson);
    return openai.translateRequest(
      req,
      inp["providerModel"] as String? ?? "",
      inp["stream"] == true,
    );
  },
  "openai_response": (inp) {
    return openai.translateResponse(
      inp["response"],
      inp["providerModel"] as String? ?? "",
      inp["label"] as String? ?? "openai",
    );
  },
  "openai_chunk": (inp) {
    return openai.translateChunk(
      inp["response"],
      inp["providerModel"] as String? ?? "",
      inp["label"] as String? ?? "openai",
    );
  },
  "anthropic_request": (inp) {
    final reqJson = inp["request"] is Map ? Map<String, dynamic>.from(inp["request"] as Map) : <String, dynamic>{};
    final req = ChatRequest.fromJson(reqJson);
    return anthropic.translateRequest(
      req,
      inp["providerModel"] as String? ?? "",
      inp["stream"] == true,
    );
  },
  "anthropic_response": (inp) {
    return anthropic.translateResponse(
      inp["response"],
      inp["providerModel"] as String? ?? "",
    );
  },
  "gemini_request": (inp) {
    final reqJson = inp["request"] is Map ? Map<String, dynamic>.from(inp["request"] as Map) : <String, dynamic>{};
    final req = ChatRequest.fromJson(reqJson);
    return gemini.translateRequest(
      req,
      inp["providerModel"] as String? ?? "",
      inp["stream"] == true,
    );
  },
  "gemini_response": (inp) {
    return gemini.translateResponse(
      inp["response"],
      inp["providerModel"] as String? ?? "",
    );
  },
  "bedrock_request": (inp) {
    final reqJson = inp["request"] is Map ? Map<String, dynamic>.from(inp["request"] as Map) : <String, dynamic>{};
    final req = ChatRequest.fromJson(reqJson);
    return bedrock.translateRequest(
      req,
      inp["providerModel"] as String? ?? "",
      inp["stream"] == true,
    );
  },
  "bedrock_response": (inp) {
    return bedrock.translateResponse(
      inp["response"],
      inp["providerModel"] as String? ?? "",
    );
  },
  "sse_parse": (inp) async {
    final rawChunks = inp["response"] as List? ?? [];
    final stringChunks = rawChunks.map((c) => c.toString()).toList();
    final out = <String>[];
    await for (final data in sseData(streamFromChunks(stringChunks))) {
      out.add(data);
    }
    return out;
  },
};

Future<CaseResult> runTranslationCase(
  Map<String, dynamic> caseDict, [
  Map<String, TranslationHandler>? handlers,
]) async {
  final hMap = handlers ?? builtinHandlers;
  final kind = caseDict["kind"] as String? ?? "";
  final name = caseDict["name"] as String? ?? "";
  final handler = hMap[kind];

  if (handler == null) {
    return CaseResult(
      name: name,
      ok: false,
      expected: "a registered translation handler",
      actual: 'no handler for kind "$kind"',
    );
  }

  final inp = <String, dynamic>{
    "request": caseDict["request"],
    "response": caseDict["response"],
    "providerModel": caseDict["providerModel"] ?? "",
    "stream": caseDict["stream"] == true,
    "label": caseDict["label"] ?? "openai",
  };

  final actualObj = await handler(inp);
  final expectedStr = stableJson(caseDict["expected"]);
  final actualStr = stableJson(actualObj);

  final ok = expectedStr == actualStr;
  return CaseResult(
    name: name,
    ok: ok,
    expected: ok ? null : expectedStr,
    actual: ok ? null : actualStr,
  );
}
