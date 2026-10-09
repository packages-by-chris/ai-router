import "dart:async";
import "dart:convert";
import "package:http/http.dart" as http;
import "../errors.dart";
import "../http/request.dart";
import "../http/sse.dart";
import "../types.dart";
import "types.dart";

const String geminiDefaultBaseUrl = "https://generativelanguage.googleapis.com/v1beta";

const Map<String, int> geminiThinkingBudgets = {
  "low": 1024,
  "medium": 8192,
  "high": 24576,
};

String _baseUrl(NormalizedRoute route) {
  final base = route.baseUrl ?? geminiDefaultBaseUrl;
  return base.replaceAll(RegExp(r"/+$"), "");
}

String? mapFinishReason(Object? finishReason) {
  if (finishReason == null) return null;
  final str = finishReason.toString();
  switch (str) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
      return "content_filter";
    default:
      return str;
  }
}

class _GeminiTurn {
  final String role; // "user" | "model"
  final List<Map<String, dynamic>> parts;
  _GeminiTurn(this.role, this.parts);
}

String _guessImageMime(String url) {
  try {
    final uri = Uri.parse(url);
    final ext = uri.pathSegments.isNotEmpty ? uri.pathSegments.last.split(".").last.toLowerCase() : "";
    switch (ext) {
      case "png":
        return "image/png";
      case "webp":
        return "image/webp";
      case "gif":
        return "image/gif";
      default:
        return "image/jpeg";
    }
  } catch (_) {
    return "image/jpeg";
  }
}

Map<String, dynamic>? _imagePart(String url) {
  final dataUriMatch = RegExp(r"^data:([^;,]+);base64,(.*)$", caseSensitive: false).firstMatch(url);
  if (dataUriMatch != null) {
    return <String, dynamic>{
      "inlineData": <String, dynamic>{
        "mimeType": dataUriMatch.group(1)!,
        "data": dataUriMatch.group(2)!,
      },
    };
  }
  if (RegExp(r"^https?://", caseSensitive: false).hasMatch(url)) {
    return <String, dynamic>{
      "fileData": <String, dynamic>{
        "mimeType": _guessImageMime(url),
        "fileUri": url,
      },
    };
  }
  return null;
}

void _pushUnifiedContent(
  void Function(String role, Map<String, dynamic> part) push,
  String role,
  Object? content,
) {
  if (content is String) {
    if (content.isNotEmpty) push(role, <String, dynamic>{"text": content});
    return;
  }
  if (content is List) {
    for (final part in content) {
      if (part is TextPart) {
        if (part.text.isNotEmpty) push(role, <String, dynamic>{"text": part.text});
      } else if (part is Map && part["type"] == "text") {
        final text = part["text"] as String? ?? "";
        if (text.isNotEmpty) push(role, <String, dynamic>{"text": text});
      } else if (part is ImageUrlPart) {
        final img = _imagePart(part.url);
        if (img != null) push(role, img);
      } else if (part is Map && part["type"] == "image_url") {
        final url = part["image_url"] is Map
            ? (part["image_url"]["url"] as String? ?? "")
            : "";
        final img = _imagePart(url);
        if (img != null) push(role, img);
      }
    }
  }
}

Map<String, dynamic> translateRequest(
  ChatRequest req,
  String providerModel,
  bool stream,
) {
  final systemParts = <String>[];
  final callNames = <String, String>{};

  for (final msg in req.messages) {
    if (msg.toolCalls != null) {
      for (final tc in msg.toolCalls!) {
        callNames[tc.id] = tc.function.name;
      }
    }
  }

  final turns = <_GeminiTurn>[];
  void push(String role, Map<String, dynamic> part) {
    if (turns.isNotEmpty && turns.last.role == role) {
      turns.last.parts.add(part);
    } else {
      turns.add(_GeminiTurn(role, <Map<String, dynamic>>[part]));
    }
  }

  for (final msg in req.messages) {
    if (msg.role == Roles.system) {
      if (msg.content is String) {
        final str = msg.content as String;
        if (str.isNotEmpty) systemParts.add(str);
      } else if (msg.content is List) {
        for (final p in msg.content as List) {
          final text = p is TextPart
              ? p.text
              : (p is Map && p["type"] == "text" && p["text"] is String ? p["text"] as String : null);
          if (text != null && text.isNotEmpty) systemParts.add(text);
        }
      }
      continue;
    }

    if (msg.role == Roles.tool) {
      final id = msg.toolCallId ?? "";
      final name = callNames[id] ?? msg.name ?? "";
      String resultText = "";
      if (msg.content is String) {
        resultText = msg.content as String;
      } else if (msg.content is List) {
        resultText = (msg.content as List)
            .map((p) => p is TextPart ? p.text : (p is Map && p["type"] == "text" && p["text"] is String ? p["text"] as String : ""))
            .where((s) => s.isNotEmpty)
            .join("\n");
      }
      push("user", <String, dynamic>{
        "functionResponse": <String, dynamic>{
          "name": name,
          if (id.isNotEmpty) "id": id,
          "response": <String, dynamic>{"result": resultText},
        },
      });
      continue;
    }

    final role = msg.role == Roles.assistant ? "model" : "user";
    _pushUnifiedContent(push, role, msg.content);

    if (msg.toolCalls != null) {
      for (final tc in msg.toolCalls!) {
        Object args = <String, dynamic>{};
        try {
          args = jsonDecode(tc.function.arguments.isNotEmpty ? tc.function.arguments : "{}") as Object;
        } catch (_) {
          args = <String, dynamic>{};
        }
        push(role, <String, dynamic>{
          "functionCall": <String, dynamic>{
            "name": tc.function.name,
            "args": args,
            if (tc.id.isNotEmpty) "id": tc.id,
          },
        });
      }
    }
  }

  final body = <String, dynamic>{
    "contents": turns.map((t) => <String, dynamic>{"role": t.role, "parts": t.parts}).toList(),
  };

  if (systemParts.isNotEmpty) {
    body["systemInstruction"] = <String, dynamic>{
      "parts": systemParts.map((t) => <String, dynamic>{"text": t}).toList(),
    };
  }

  final generationConfig = <String, dynamic>{};
  if (req.temperature != null) generationConfig["temperature"] = req.temperature;
  if (req.topP != null) generationConfig["topP"] = req.topP;
  if (req.maxTokens != null) generationConfig["maxOutputTokens"] = req.maxTokens;
  if (req.stop != null) {
    generationConfig["stopSequences"] = req.stop is List ? req.stop : <dynamic>[req.stop];
  }
  if (req.responseFormat is JsonObjectResponseFormat ||
      (req.responseFormat != null && req.responseFormat!.type == "json_object")) {
    generationConfig["responseMimeType"] = "application/json";
  }
  if (req.responseFormat is JsonSchemaResponseFormat) {
    generationConfig["responseMimeType"] = "application/json";
    generationConfig["responseJsonSchema"] = (req.responseFormat as JsonSchemaResponseFormat).schema;
  }
  if (req.reasoningEffort != null) {
    generationConfig["thinkingConfig"] = <String, dynamic>{
      "thinkingBudget": geminiThinkingBudgets[req.reasoningEffort] ?? 8192,
      "includeThoughts": true,
    };
  }
  if (generationConfig.isNotEmpty) {
    body["generationConfig"] = generationConfig;
  }

  final sendTools = req.toolChoice != "none" && req.tools != null && req.tools!.isNotEmpty;
  if (sendTools) {
    body["tools"] = <Map<String, dynamic>>[
      <String, dynamic>{
        "functionDeclarations": req.tools!.map((t) => <String, dynamic>{
              "name": t.function.name,
              if (t.function.description != null) "description": t.function.description,
              "parameters": t.function.parameters,
            }).toList(),
      },
    ];

    final choice = req.toolChoice;
    if (choice == "auto") {
      body["toolConfig"] = <String, dynamic>{
        "functionCallingConfig": <String, dynamic>{"mode": "AUTO"},
      };
    } else if (choice == "required") {
      body["toolConfig"] = <String, dynamic>{
        "functionCallingConfig": <String, dynamic>{"mode": "ANY"},
      };
    } else if (choice is Map && choice["function"] is Map) {
      body["toolConfig"] = <String, dynamic>{
        "functionCallingConfig": <String, dynamic>{
          "mode": "ANY",
          "allowedFunctionNames": <String>[(choice["function"] as Map)["name"] as String],
        },
      };
    }
  }

  final extra = req.providerOptions?["gemini"];
  if (extra != null) {
    body.addAll(extra);
  }

  return body;
}

Usage? toUsage(Object? v) {
  if (v is! Map) return null;
  final u = Map<String, dynamic>.from(v);
  final prompt = u["promptTokenCount"];
  final completion = u["candidatesTokenCount"];
  if (prompt is! num || completion is! num) return null;
  final pTok = prompt.toInt();
  final cTok = completion.toInt();
  final total = u["totalTokenCount"] is num ? (u["totalTokenCount"] as num).toInt() : pTok + cTok;
  final cached = (u["cachedContentTokenCount"] as num?)?.toInt();
  final thoughts = (u["thoughtsTokenCount"] as num?)?.toInt();
  return Usage(
    promptTokens: pTok,
    completionTokens: cTok,
    totalTokens: total,
    cachedTokens: cached != null && cached > 0 ? cached : null,
    reasoningTokens: thoughts != null && thoughts > 0 ? thoughts : null,
  );
}

class _PartsUnified {
  final String text;
  final String reasoning;
  final List<ToolCall> toolCalls;
  const _PartsUnified(this.text, this.reasoning, this.toolCalls);
}

_PartsUnified _partsToUnified(List<dynamic> parts) {
  String text = "";
  String reasoning = "";
  final toolCalls = <ToolCall>[];

  for (final p in parts) {
    if (p is! Map) continue;
    if (p["text"] is String) {
      if (p["thought"] == true) {
        reasoning += p["text"] as String;
      } else {
        text += p["text"] as String;
      }
    } else if (p["functionCall"] is Map) {
      final fc = p["functionCall"] as Map;
      final index = toolCalls.length;
      final id = fc["id"] is String && (fc["id"] as String).isNotEmpty
          ? fc["id"] as String
          : "call_$index";
      toolCalls.add(ToolCall(
        id: id,
        type: "function",
        function: ToolCallFunction(
          name: fc["name"] as String? ?? "",
          arguments: jsonEncode(fc["args"] ?? <String, dynamic>{}),
        ),
      ));
    }
  }

  return _PartsUnified(text, reasoning, toolCalls);
}

ChatResponse translateResponse(Object? json, String providerModel) {
  final j = json is Map ? Map<String, dynamic>.from(json) : <String, dynamic>{};
  final candidates = j["candidates"] is List ? j["candidates"] as List : <dynamic>[];
  final candidate = candidates.isNotEmpty && candidates[0] is Map
      ? Map<String, dynamic>.from(candidates[0] as Map)
      : null;
  final blocked = (j["promptFeedback"] is Map && (j["promptFeedback"] as Map)["blockReason"] != null);

  String text = "";
  String reasoning = "";
  List<ToolCall> toolCalls = [];
  String? finish;

  if (candidate != null) {
    final content = candidate["content"] is Map ? candidate["content"] as Map : <String, dynamic>{};
    final parts = content["parts"] is List ? content["parts"] as List : <dynamic>[];
    final unified = _partsToUnified(parts);
    text = unified.text;
    reasoning = unified.reasoning;
    toolCalls = unified.toolCalls;
    finish = mapFinishReason(candidate["finishReason"]);
  } else if (blocked) {
    finish = "content_filter";
  }

  return ChatResponse(
    id: j["responseId"] as String? ?? "",
    model: j["modelVersion"] as String? ?? providerModel,
    provider: "gemini",
    created: 0,
    usage: toUsage(j["usageMetadata"]),
    choices: [
      Choice(
        index: 0,
        finishReason: finish,
        message: ChatMessage(
          role: Roles.assistant,
          content: text.isNotEmpty ? text : toolCalls.isNotEmpty ? null : "",
          reasoning: reasoning.isNotEmpty ? reasoning : null,
          toolCalls: toolCalls.isNotEmpty ? toolCalls : null,
        ),
      ),
    ],
  );
}

ErrorKind _classifyStreamError(Object? status) {
  final str = status?.toString();
  switch (str) {
    case "INVALID_ARGUMENT":
      return ErrorKinds.invalidRequest;
    case "UNAUTHENTICATED":
      return ErrorKinds.auth;
    case "PERMISSION_DENIED":
      return ErrorKinds.permission;
    case "NOT_FOUND":
      return ErrorKinds.notFound;
    case "RESOURCE_EXHAUSTED":
      return ErrorKinds.rateLimit;
    case "INTERNAL":
    case "UNAVAILABLE":
      return ErrorKinds.server;
    default:
      return ErrorKinds.unknown;
  }
}

class GeminiAdapter implements ProviderAdapter {
  @override
  String get id => "gemini";

  Map<String, String> _headers(NormalizedRoute route, String key) => <String, String>{
        "content-type": "application/json",
        "x-goog-api-key": key,
        ...route.headers,
      };

  @override
  Future<http.Response> raw(
    NormalizedRoute route,
    String key,
    RawRequestOptions opts,
    AdapterContext ctx,
  ) async {
    final encodedModel = Uri.encodeComponent(route.model);
    final defaultPath = "/models/$encodedModel:generateContent";
    final url = "${_baseUrl(route)}${opts.path ?? defaultPath}";
    final headers = <String, String>{
      ..._headers(route, key),
      if (opts.headers != null) ...opts.headers!,
    };
    final client = ctx.client ?? http.Client();
    try {
      final req = http.Request(opts.method ?? "POST", Uri.parse(url));
      req.headers.addAll(headers);
      if (opts.body != null) {
        req.body = opts.body is String ? opts.body as String : jsonEncode(opts.body);
      }
      final streamResp = await client.send(req).timeout(
            Duration(milliseconds: route.timeoutMs),
          );
      return await http.Response.fromStream(streamResp);
    } catch (err) {
      throw toNetworkError("gemini", err);
    }
  }

  @override
  Future<ChatResponse> complete(
    NormalizedRoute route,
    String key,
    ChatRequest req,
    AdapterContext ctx,
  ) async {
    final encodedModel = Uri.encodeComponent(route.model);
    final url = "${_baseUrl(route)}/models/$encodedModel:generateContent";
    final body = translateRequest(req, route.model, false);
    final client = ctx.client ?? http.Client();

    http.Response resp;
    try {
      final request = http.Request("POST", Uri.parse(url));
      request.headers.addAll(_headers(route, key));
      request.body = jsonEncode(body);
      final streamResp = await client.send(request).timeout(
            Duration(milliseconds: route.timeoutMs),
          );
      resp = await http.Response.fromStream(streamResp);
    } catch (err) {
      throw toNetworkError("gemini", err);
    }

    await requireOk(resp, "gemini");
    final json = jsonDecode(resp.body);
    return translateResponse(json, route.model);
  }

  @override
  Future<Stream<ChatChunk>> stream(
    NormalizedRoute route,
    String key,
    ChatRequest req,
    AdapterContext ctx,
  ) async {
    final encodedModel = Uri.encodeComponent(route.model);
    final url = "${_baseUrl(route)}/models/$encodedModel:streamGenerateContent?alt=sse";
    final body = translateRequest(req, route.model, true);
    final client = ctx.client ?? http.Client();

    final request = http.Request("POST", Uri.parse(url));
    request.headers.addAll(_headers(route, key));
    request.body = jsonEncode(body);

    http.StreamedResponse streamedResponse;
    try {
      streamedResponse = await client.send(request).timeout(
            Duration(milliseconds: route.timeoutMs),
          );
    } catch (err) {
      throw toNetworkError("gemini", err);
    }

    if (streamedResponse.statusCode < 200 || streamedResponse.statusCode >= 300) {
      final resp = await http.Response.fromStream(streamedResponse);
      await requireOk(resp, "gemini");
    }

    final model = route.model;

    Stream<ChatChunk> generator() async* {
      String servedModel = model;
      bool roleSent = false;
      String? finish;
      Usage? usage;

      List<ChatChunk> ensureRole() {
        if (!roleSent) {
          roleSent = true;
          return [
            ChatChunk(
              id: "",
              model: servedModel,
              provider: "gemini",
              delta: const Delta(role: Roles.assistant),
            )
          ];
        }
        return const [];
      }

      await for (final data in sseData(streamedResponse.stream)) {
        Object? evRaw;
        try {
          evRaw = jsonDecode(data);
        } catch (_) {
          continue;
        }
        if (evRaw is! Map) continue;
        final ev = Map<String, dynamic>.from(evRaw);

        if (ev["error"] is Map) {
          final err = ev["error"] as Map;
          throw ProviderError(
            "gemini",
            _classifyStreamError(err["status"]),
            "gemini: ${err["message"] ?? "stream error"}",
            body: ev,
          );
        }

        final candidates = ev["candidates"] is List ? ev["candidates"] as List : <dynamic>[];
        final candidate = candidates.isNotEmpty && candidates[0] is Map
            ? Map<String, dynamic>.from(candidates[0] as Map)
            : null;

        if (candidate != null) {
          final content = candidate["content"] is Map ? candidate["content"] as Map : <String, dynamic>{};
          final parts = content["parts"] is List ? content["parts"] as List : <dynamic>[];
          for (final part in parts) {
            if (part is! Map) continue;
            if (part["text"] is String && (part["text"] as String).isNotEmpty) {
              for (final c in ensureRole()) {
                yield c;
              }
              if (part["thought"] == true) {
                yield ChatChunk(
                  id: "",
                  model: servedModel,
                  provider: "gemini",
                  delta: Delta(reasoning: part["text"] as String),
                );
              } else {
                yield ChatChunk(
                  id: "",
                  model: servedModel,
                  provider: "gemini",
                  delta: Delta(content: part["text"] as String),
                );
              }
            } else if (part["functionCall"] is Map) {
              for (final c in ensureRole()) {
                yield c;
              }
              final fc = part["functionCall"] as Map;
              final id = fc["id"] is String && (fc["id"] as String).isNotEmpty ? fc["id"] as String : null;
              yield ChatChunk(
                id: "",
                model: servedModel,
                provider: "gemini",
                delta: Delta(
                  toolCalls: [
                    ToolCallDelta(
                      index: 0,
                      id: id,
                      type: "function",
                      function: ToolCallDeltaFunction(
                        name: fc["name"] as String? ?? "",
                        arguments: jsonEncode(fc["args"] ?? <String, dynamic>{}),
                      ),
                    ),
                  ],
                ),
              );
            }
          }

          final mapped = mapFinishReason(candidate["finishReason"]);
          if (mapped != null) finish = mapped;
        }

        final meta = toUsage(ev["usageMetadata"]);
        if (meta != null) usage = meta;
        if (ev["modelVersion"] is String) {
          servedModel = ev["modelVersion"] as String;
        }
      }

      if (finish != null || usage != null) {
        yield ChatChunk(
          id: "",
          model: servedModel,
          provider: "gemini",
          delta: const Delta(),
          finishReason: finish,
          usage: usage,
        );
      }
    }

    return generator();
  }

  @override
  Future<EmbeddingResponse> embed(
    NormalizedRoute route,
    String key,
    EmbeddingRequest req,
    AdapterContext ctx,
  ) async {
    final inputs = req.input is List ? (req.input as List).map((e) => e.toString()).toList() : [req.input.toString()];
    final encodedModel = Uri.encodeComponent(route.model);
    final url = "${_baseUrl(route)}/models/$encodedModel:batchEmbedContents";
    final body = <String, dynamic>{
      "requests": inputs.map((text) => <String, dynamic>{
            "model": "models/${route.model}",
            "content": <String, dynamic>{
              "parts": <Map<String, dynamic>>[
                <String, dynamic>{"text": text}
              ]
            }
          }).toList(),
    };

    final client = ctx.client ?? http.Client();
    http.Response resp;
    try {
      final request = http.Request("POST", Uri.parse(url));
      request.headers.addAll(_headers(route, key));
      request.body = jsonEncode(body);
      final streamResp = await client.send(request).timeout(
            Duration(milliseconds: route.timeoutMs),
          );
      resp = await http.Response.fromStream(streamResp);
    } catch (err) {
      throw toNetworkError("gemini", err);
    }

    await requireOk(resp, "gemini");
    final j = jsonDecode(resp.body) as Map<String, dynamic>;
    final raw = j["embeddings"] is List ? j["embeddings"] as List : <dynamic>[];
    final data = raw.asMap().entries.map((e) {
      final i = e.key;
      final d = e.value is Map ? Map<String, dynamic>.from(e.value as Map) : <String, dynamic>{};
      final values = d["values"] is List
          ? (d["values"] as List).map((x) => (x as num).toDouble()).toList()
          : <double>[];
      return EmbeddingData(index: i, embedding: values);
    }).toList();

    return EmbeddingResponse(
      object: "list",
      model: route.model,
      provider: "gemini",
      data: data,
      usage: toUsage(j["usageMetadata"]),
    );
  }
}
