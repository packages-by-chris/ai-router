import "dart:async";
import "dart:convert";
import "package:http/http.dart" as http;
import "../errors.dart";
import "../http/request.dart";
import "../http/sse.dart";
import "../types.dart";
import "types.dart";

const String anthropicDefaultBaseUrl = "https://api.anthropic.com/v1";
const String anthropicVersion = "2023-06-01";
const int anthropicDefaultMaxTokens = 4096;

const Map<String, int> anthropicThinkingBudgets = {
  "low": 4096,
  "medium": 12288,
  "high": 24576,
};

String _baseUrl(NormalizedRoute route) {
  final base = route.baseUrl ?? anthropicDefaultBaseUrl;
  return base.replaceAll(RegExp(r"/+$"), "");
}

bool _wantsCache(ChatMessage msg) {
  return msg.providerOptions?["anthropic"]?["cache_control"] == true;
}

class _AnthropicTurn {
  final String role; // "user" | "assistant"
  final List<Map<String, dynamic>> blocks;
  _AnthropicTurn(this.role, this.blocks);
}

Map<String, dynamic>? _imageBlock(String url) {
  final dataUriMatch = RegExp(r"^data:([^;,]+);base64,(.*)$", caseSensitive: false).firstMatch(url);
  if (dataUriMatch != null) {
    return <String, dynamic>{
      "type": "image",
      "source": <String, dynamic>{
        "type": "base64",
        "media_type": dataUriMatch.group(1)!,
        "data": dataUriMatch.group(2)!,
      },
    };
  }
  if (RegExp(r"^https?://", caseSensitive: false).hasMatch(url)) {
    return <String, dynamic>{
      "type": "image",
      "source": <String, dynamic>{"type": "url", "url": url},
    };
  }
  return null;
}

void _pushUnifiedContent(
  void Function(String role, Map<String, dynamic> block) push,
  String role,
  Object? content,
) {
  if (content is String) {
    if (content.isNotEmpty) push(role, <String, dynamic>{"type": "text", "text": content});
    return;
  }
  if (content is List) {
    for (final part in content) {
      if (part is TextPart) {
        if (part.text.isNotEmpty) {
          push(role, <String, dynamic>{"type": "text", "text": part.text});
        }
      } else if (part is Map) {
        final text = part["text"] is String ? part["text"] as String : "";
        if (text.isNotEmpty) {
          push(role, <String, dynamic>{"type": "text", "text": text});
        }
      } else if (part is ImageUrlPart) {
        final block = _imageBlock(part.url);
        if (block != null) push(role, block);
      } else if (part is Map && part["type"] == "image_url") {
        final url = part["image_url"] is Map
            ? (part["image_url"]["url"] as String? ?? "")
            : "";
        final block = _imageBlock(url);
        if (block != null) push(role, block);
      }
    }
  }
}

Map<String, dynamic> translateRequest(
  ChatRequest req,
  String providerModel,
  bool stream,
) {
  final systemBlocks = <Map<String, dynamic>>[];
  bool systemHasCacheMarker = false;
  final turns = <_AnthropicTurn>[];

  void push(String role, Map<String, dynamic> block) {
    if (turns.isNotEmpty && turns.last.role == role) {
      turns.last.blocks.add(block);
    } else {
      turns.add(_AnthropicTurn(role, <Map<String, dynamic>>[block]));
    }
  }

  for (final msg in req.messages) {
    if (msg.role == Roles.system) {
      final flag = _wantsCache(msg);
      if (flag) systemHasCacheMarker = true;
      if (msg.content is String) {
        final str = msg.content as String;
        if (str.isNotEmpty) {
          systemBlocks.add(<String, dynamic>{
            "type": "text",
            "text": str,
            if (flag) "cache_control": <String, dynamic>{"type": "ephemeral"},
          });
        }
      } else if (msg.content is List) {
        final parts = (msg.content as List).where((p) {
          if (p is TextPart) return p.text.isNotEmpty;
          if (p is Map && p["type"] == "text") {
            final t = p["text"];
            return t is String && t.isNotEmpty;
          }
          return false;
        }).toList();

        for (int i = 0; i < parts.length; i++) {
          final p = parts[i];
          final text = p is TextPart
              ? p.text
              : (p is Map && p["text"] is String ? p["text"] as String : "");
          systemBlocks.add(<String, dynamic>{
            "type": "text",
            "text": text,
            if (flag && i == parts.length - 1)
              "cache_control": <String, dynamic>{"type": "ephemeral"},
          });
        }
      }
      continue;
    }

    if (msg.role == Roles.tool) {
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
        "type": "tool_result",
        "tool_use_id": msg.toolCallId ?? "",
        "content": resultText,
      });
      continue;
    }

    final role = msg.role == Roles.assistant ? "assistant" : "user";
    final local = <Map<String, dynamic>>[];
    _pushUnifiedContent((r, block) {
      if (r == role) local.add(block);
    }, role, msg.content);

    if (msg.toolCalls != null) {
      for (final tc in msg.toolCalls!) {
        Object input = <String, dynamic>{};
        try {
          input = jsonDecode(tc.function.arguments.isNotEmpty ? tc.function.arguments : "{}") as Object;
        } catch (_) {
          input = <String, dynamic>{};
        }
        local.add(<String, dynamic>{
          "type": "tool_use",
          "id": tc.id,
          "name": tc.function.name,
          "input": input,
        });
      }
    }

    if (_wantsCache(msg) && local.isNotEmpty) {
      local.last["cache_control"] = <String, dynamic>{"type": "ephemeral"};
    }

    if (local.isNotEmpty) {
      if (turns.isNotEmpty && turns.last.role == role) {
        turns.last.blocks.addAll(local);
      } else {
        turns.add(_AnthropicTurn(role, local));
      }
    }
  }

  final body = <String, dynamic>{
    "model": providerModel,
    "max_tokens": req.maxTokens ?? anthropicDefaultMaxTokens,
    "messages": turns.map((t) => <String, dynamic>{"role": t.role, "content": t.blocks}).toList(),
  };

  if (systemBlocks.isNotEmpty) {
    if (systemHasCacheMarker) {
      body["system"] = systemBlocks;
    } else {
      body["system"] = systemBlocks.map((b) => b["text"]).join("\n\n");
    }
  }

  if (req.temperature != null) body["temperature"] = req.temperature;
  if (req.topP != null) body["top_p"] = req.topP;
  if (req.stop != null) {
    body["stop_sequences"] = req.stop is List ? req.stop : <dynamic>[req.stop];
  }

  final sendTools = req.toolChoice != "none" && req.tools != null && req.tools!.isNotEmpty;
  if (sendTools) {
    body["tools"] = req.tools!.map((t) => <String, dynamic>{
          "name": t.function.name,
          if (t.function.description != null) "description": t.function.description,
          "input_schema": t.function.parameters,
        }).toList();

    final choice = req.toolChoice;
    if (choice == "auto") {
      body["tool_choice"] = <String, dynamic>{"type": "auto"};
    } else if (choice == "required") {
      body["tool_choice"] = <String, dynamic>{"type": "any"};
    } else if (choice is Map && choice["function"] is Map) {
      body["tool_choice"] = <String, dynamic>{
        "type": "tool",
        "name": (choice["function"] as Map)["name"],
      };
    }
  }

  if (req.reasoningEffort != null) {
    final budget = anthropicThinkingBudgets[req.reasoningEffort] ?? 4096;
    body["thinking"] = <String, dynamic>{"type": "enabled", "budget_tokens": budget};
    body.remove("temperature");
    body.remove("top_p");
    final currentMax = body["max_tokens"] is int ? body["max_tokens"] as int : anthropicDefaultMaxTokens;
    if (currentMax <= budget) {
      body["max_tokens"] = budget + 1024;
    }
    final tc = body["tool_choice"];
    if (tc is Map && tc["type"] != "auto") {
      body.remove("tool_choice");
    }
  }

  if (stream) body["stream"] = true;

  final extra = req.providerOptions?["anthropic"];
  if (extra != null) {
    body.addAll(extra);
  }

  return body;
}

String? mapFinishReason(Object? stopReason) {
  if (stopReason == null) return null;
  final str = stopReason.toString();
  switch (str) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      return str;
  }
}

Usage? toUsage(Object? v) {
  if (v is! Map) return null;
  final u = Map<String, dynamic>.from(v);
  final input = u["input_tokens"];
  final output = u["output_tokens"];
  if (input is! num || output is! num) return null;
  final inTok = input.toInt();
  final outTok = output.toInt();
  final cacheRead = (u["cache_read_input_tokens"] as num?)?.toInt() ?? 0;
  final cacheWrite = (u["cache_creation_input_tokens"] as num?)?.toInt() ?? 0;
  return Usage(
    promptTokens: inTok,
    completionTokens: outTok,
    totalTokens: inTok + outTok + cacheRead + cacheWrite,
    cachedTokens: cacheRead > 0 ? cacheRead : null,
    cacheWriteTokens: cacheWrite > 0 ? cacheWrite : null,
  );
}

ChatResponse translateResponse(Object? json, String providerModel) {
  final j = json is Map ? Map<String, dynamic>.from(json) : <String, dynamic>{};
  final blocks = j["content"] is List ? j["content"] as List : <dynamic>[];

  String text = "";
  String reasoning = "";
  final toolCalls = <ToolCall>[];

  for (final b in blocks) {
    if (b is! Map) continue;
    final type = b["type"];
    if (type == "text" && b["text"] is String) {
      text += b["text"] as String;
    } else if (type == "thinking" && b["thinking"] is String) {
      reasoning += b["thinking"] as String;
    } else if (type == "tool_use") {
      toolCalls.add(ToolCall(
        id: b["id"] as String? ?? "",
        type: "function",
        function: ToolCallFunction(
          name: b["name"] as String? ?? "",
          arguments: jsonEncode(b["input"] ?? <String, dynamic>{}),
        ),
      ));
    }
  }

  return ChatResponse(
    id: j["id"] as String? ?? "",
    model: j["model"] as String? ?? providerModel,
    provider: "anthropic",
    created: 0,
    usage: toUsage(j["usage"]),
    choices: [
      Choice(
        index: 0,
        finishReason: mapFinishReason(j["stop_reason"]),
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

ErrorKind _classifyStreamErrorType(Object? type) {
  final str = type?.toString();
  switch (str) {
    case "invalid_request_error":
      return ErrorKinds.invalidRequest;
    case "authentication_error":
      return ErrorKinds.auth;
    case "permission_error":
      return ErrorKinds.permission;
    case "not_found_error":
      return ErrorKinds.notFound;
    case "rate_limit_error":
      return ErrorKinds.rateLimit;
    case "overloaded_error":
    case "api_error":
      return ErrorKinds.server;
    default:
      return ErrorKinds.unknown;
  }
}

class AnthropicAdapter implements ProviderAdapter {
  @override
  String get id => "anthropic";

  Map<String, String> _headers(NormalizedRoute route, String key) => <String, String>{
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": anthropicVersion,
        ...route.headers,
      };

  @override
  Future<http.Response> raw(
    NormalizedRoute route,
    String key,
    RawRequestOptions opts,
    AdapterContext ctx,
  ) async {
    final url = "${_baseUrl(route)}${opts.path ?? "/messages"}";
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
      throw toNetworkError("anthropic", err);
    }
  }

  @override
  Future<ChatResponse> complete(
    NormalizedRoute route,
    String key,
    ChatRequest req,
    AdapterContext ctx,
  ) async {
    final url = "${_baseUrl(route)}/messages";
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
      throw toNetworkError("anthropic", err);
    }

    await requireOk(resp, "anthropic");
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
    final url = "${_baseUrl(route)}/messages";
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
      throw toNetworkError("anthropic", err);
    }

    if (streamedResponse.statusCode < 200 || streamedResponse.statusCode >= 300) {
      final resp = await http.Response.fromStream(streamedResponse);
      await requireOk(resp, "anthropic");
    }

    final model = route.model;

    Stream<ChatChunk> generator() async* {
      String id = "";
      String servedModel = model;
      int? inputTokens;
      int? outputTokens;
      int cacheRead = 0;
      int cacheWrite = 0;
      String? finish;

      ChatChunk chunk(Delta delta, [String? finishReason, Usage? usage]) => ChatChunk(
            id: id,
            model: servedModel,
            provider: "anthropic",
            delta: delta,
            finishReason: finishReason,
            usage: usage,
          );

      await for (final data in sseData(streamedResponse.stream)) {
        Object? evRaw;
        try {
          evRaw = jsonDecode(data);
        } catch (_) {
          continue;
        }
        if (evRaw is! Map) continue;
        final ev = Map<String, dynamic>.from(evRaw);
        final type = ev["type"];

        switch (type) {
          case "message_start":
            final message = ev["message"] is Map ? Map<String, dynamic>.from(ev["message"] as Map) : <String, dynamic>{};
            if (message["id"] is String) id = message["id"] as String;
            if (message["model"] is String) servedModel = message["model"] as String;
            final u = message["usage"] is Map ? Map<String, dynamic>.from(message["usage"] as Map) : <String, dynamic>{};
            if (u["input_tokens"] is num) inputTokens = (u["input_tokens"] as num).toInt();
            if (u["cache_read_input_tokens"] is num) {
              cacheRead = (u["cache_read_input_tokens"] as num).toInt();
            }
            if (u["cache_creation_input_tokens"] is num) {
              cacheWrite = (u["cache_creation_input_tokens"] as num).toInt();
            }
            yield chunk(const Delta(role: Roles.assistant));
            break;

          case "content_block_start":
            final block = ev["content_block"] is Map
                ? Map<String, dynamic>.from(ev["content_block"] as Map)
                : <String, dynamic>{};
            if (block["type"] == "tool_use") {
              yield chunk(Delta(
                toolCalls: [
                  ToolCallDelta(
                    index: (ev["index"] as num?)?.toInt() ?? 0,
                    id: block["id"] as String? ?? "",
                    type: "function",
                    function: ToolCallDeltaFunction(
                      name: block["name"] as String? ?? "",
                      arguments: "",
                    ),
                  ),
                ],
              ));
            }
            break;

          case "content_block_delta":
            final delta = ev["delta"] is Map
                ? Map<String, dynamic>.from(ev["delta"] as Map)
                : <String, dynamic>{};
            final index = (ev["index"] as num?)?.toInt() ?? 0;
            if (delta["type"] == "text_delta" && delta["text"] is String && (delta["text"] as String).isNotEmpty) {
              yield chunk(Delta(content: delta["text"] as String));
            } else if (delta["type"] == "thinking_delta" && delta["thinking"] is String) {
              yield chunk(Delta(reasoning: delta["thinking"] as String));
            } else if (delta["type"] == "input_json_delta") {
              yield chunk(Delta(
                toolCalls: [
                  ToolCallDelta(
                    index: index,
                    function: ToolCallDeltaFunction(
                      arguments: delta["partial_json"] as String? ?? "",
                    ),
                  ),
                ],
              ));
            }
            break;

          case "message_delta":
            final delta = ev["delta"] is Map
                ? Map<String, dynamic>.from(ev["delta"] as Map)
                : <String, dynamic>{};
            if (delta["stop_reason"] != null) {
              finish = mapFinishReason(delta["stop_reason"]);
            }
            final u = ev["usage"] is Map
                ? Map<String, dynamic>.from(ev["usage"] as Map)
                : <String, dynamic>{};
            if (u["output_tokens"] is num) {
              outputTokens = (u["output_tokens"] as num).toInt();
            }
            break;

          case "message_stop":
            final total = (inputTokens ?? 0) + (outputTokens ?? 0) + cacheRead + cacheWrite;
            final usage = (inputTokens != null || outputTokens != null)
                ? Usage(
                    promptTokens: inputTokens ?? 0,
                    completionTokens: outputTokens ?? 0,
                    totalTokens: total,
                    cachedTokens: cacheRead > 0 ? cacheRead : null,
                    cacheWriteTokens: cacheWrite > 0 ? cacheWrite : null,
                  )
                : null;
            yield chunk(const Delta(), finish, usage);
            return;

          case "error":
            final err = ev["error"] is Map
                ? Map<String, dynamic>.from(ev["error"] as Map)
                : <String, dynamic>{};
            throw ProviderError(
              "anthropic",
              _classifyStreamErrorType(err["type"]),
              "anthropic: ${err["message"] ?? "stream error"}",
              body: ev,
            );
        }
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
    throw UnsupportedProviderError("anthropic does not support embeddings");
  }
}
