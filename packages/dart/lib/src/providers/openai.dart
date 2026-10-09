import "dart:async";
import "dart:convert";
import "package:http/http.dart" as http;
import "../errors.dart";
import "../http/request.dart";
import "../http/sse.dart";
import "../types.dart";
import "types.dart";

const String openAiDefaultBaseUrl = "https://api.openai.com/v1";

String providerLabel(NormalizedRoute route) {
  return route.provider == "openai-compatible" ? route.id : route.provider;
}

String _baseUrl(NormalizedRoute route) {
  final base = route.baseUrl ?? openAiDefaultBaseUrl;
  return base.replaceAll(RegExp(r"/+$"), "");
}

const List<String> openAiOptionNamespaces = ["openai"];

Map<String, dynamic> mergeProviderOptions(
  Map<String, dynamic> body,
  ChatRequest req,
  List<String> namespaces,
) {
  final opts = req.providerOptions;
  if (opts == null) return body;
  for (final ns in namespaces) {
    final extra = opts[ns];
    if (extra != null) {
      body.addAll(extra);
    }
  }
  return body;
}

List<Map<String, dynamic>> wireMessages(List<ChatMessage> messages) {
  return messages.map((m) {
    final map = <String, dynamic>{
      "role": m.role,
      "content": m.content is List
          ? (m.content as List).map((p) => p is ContentPart ? p.toJson() : p).toList()
          : m.content,
    };
    if (m.name != null) map["name"] = m.name;
    if (m.toolCalls != null) {
      map["tool_calls"] = m.toolCalls!.map((tc) => tc.toJson()).toList();
    }
    if (m.toolCallId != null) map["tool_call_id"] = m.toolCallId;
    return map;
  }).toList();
}

Map<String, dynamic> translateRequest(
  ChatRequest req,
  String providerModel,
  bool stream,
) {
  final body = <String, dynamic>{
    "model": providerModel,
    "messages": wireMessages(req.messages),
  };
  if (req.tools != null) {
    body["tools"] = req.tools!.map((t) => t.toJson()).toList();
  }
  if (req.toolChoice != null) body["tool_choice"] = req.toolChoice;
  if (req.temperature != null) body["temperature"] = req.temperature;
  if (req.topP != null) body["top_p"] = req.topP;
  if (req.maxTokens != null) body["max_tokens"] = req.maxTokens;
  if (req.stop != null) body["stop"] = req.stop;
  if (req.responseFormat != null) {
    body["response_format"] = req.responseFormat!.toJson();
  }
  if (req.reasoningEffort != null) {
    body["reasoning_effort"] = req.reasoningEffort;
  }
  if (req.user != null) body["user"] = req.user;
  if (stream) {
    body["stream"] = true;
    final override = req.providerOptions?["openai"]?["stream_options"];
    if (override == null && (req.providerOptions?["openai"] == null || !req.providerOptions!["openai"]!.containsKey("stream_options"))) {
      body["stream_options"] = {"include_usage": true};
    }
  }

  final merged = mergeProviderOptions(body, req, openAiOptionNamespaces);
  if (merged.containsKey("stream_options") && merged["stream_options"] == null) {
    merged.remove("stream_options");
  }
  return merged;
}

Map<String, int> usageDetails(Map<String, dynamic> u) {
  final out = <String, int>{};
  final promptDetails = u["prompt_tokens_details"];
  if (promptDetails is Map && promptDetails["cached_tokens"] is num) {
    out["cached_tokens"] = (promptDetails["cached_tokens"] as num).toInt();
  }
  final completionDetails = u["completion_tokens_details"];
  if (completionDetails is Map && completionDetails["reasoning_tokens"] is num) {
    out["reasoning_tokens"] = (completionDetails["reasoning_tokens"] as num).toInt();
  }
  return out;
}

Usage? toUsage(Object? v) {
  if (v is! Map) return null;
  final u = Map<String, dynamic>.from(v);
  if (u["prompt_tokens"] is! num ||
      u["completion_tokens"] is! num ||
      u["total_tokens"] is! num) {
    return null;
  }
  final details = usageDetails(u);
  return Usage(
    promptTokens: (u["prompt_tokens"] as num).toInt(),
    completionTokens: (u["completion_tokens"] as num).toInt(),
    totalTokens: (u["total_tokens"] as num).toInt(),
    cachedTokens: details["cached_tokens"],
    reasoningTokens: details["reasoning_tokens"],
  );
}

Role toRole(Object? v) {
  if (v == "system" || v == "user" || v == "assistant" || v == "tool") {
    return v as String;
  }
  return Roles.assistant;
}

ChatResponse translateResponse(
  Object? json,
  String providerModel, [
  String providerLabel = "openai",
]) {
  final j = json is Map ? Map<String, dynamic>.from(json) : <String, dynamic>{};
  final choicesRaw = j["choices"] is List ? j["choices"] as List : <dynamic>[];
  return ChatResponse(
    id: j["id"] as String? ?? "",
    model: j["model"] as String? ?? providerModel,
    provider: providerLabel,
    created: (j["created"] as num?)?.toInt() ?? 0,
    usage: toUsage(j["usage"]),
    choices: choicesRaw.asMap().entries.map((e) {
      final i = e.key;
      final c = e.value is Map ? Map<String, dynamic>.from(e.value as Map) : <String, dynamic>{};
      final msg = c["message"] is Map ? Map<String, dynamic>.from(c["message"] as Map) : <String, dynamic>{};

      List<ToolCall>? toolCalls;
      if (msg["tool_calls"] is List) {
        toolCalls = (msg["tool_calls"] as List)
            .map((tc) => tc is Map ? ToolCall.fromJson(Map<String, dynamic>.from(tc)) : null)
            .whereType<ToolCall>()
            .toList();
      }

      return Choice(
        index: (c["index"] as num?)?.toInt() ?? i,
        finishReason: c["finish_reason"] as String?,
        message: ChatMessage(
          role: toRole(msg["role"]),
          content: msg["content"] is String ? msg["content"] as String : msg["content"] == null ? null : "",
          name: msg["name"] as String?,
          toolCalls: toolCalls,
          toolCallId: msg["tool_call_id"] as String?,
        ),
      );
    }).toList(),
  );
}

ChatChunk? translateChunk(
  Object? json,
  String providerModel, [
  String providerLabel = "openai",
]) {
  final j = json is Map ? Map<String, dynamic>.from(json) : <String, dynamic>{};
  final choicesRaw = j["choices"] is List ? j["choices"] as List : <dynamic>[];
  final first = choicesRaw.isNotEmpty && choicesRaw[0] is Map
      ? Map<String, dynamic>.from(choicesRaw[0] as Map)
      : null;

  Delta delta = const Delta();
  String? finishReason;

  if (first != null) {
    final d = first["delta"] is Map ? Map<String, dynamic>.from(first["delta"] as Map) : <String, dynamic>{};
    String? reasoning;
    if (d["reasoning"] is String && (d["reasoning"] as String).isNotEmpty) {
      reasoning = d["reasoning"] as String;
    } else if (d["reasoning_content"] is String && (d["reasoning_content"] as String).isNotEmpty) {
      reasoning = d["reasoning_content"] as String;
    }

    List<ToolCallDelta>? toolCalls;
    if (d["tool_calls"] is List) {
      toolCalls = (d["tool_calls"] as List)
          .map((tc) => tc is Map ? ToolCallDelta.fromJson(Map<String, dynamic>.from(tc)) : null)
          .whereType<ToolCallDelta>()
          .toList();
    }

    delta = Delta(
      role: d.containsKey("role") ? toRole(d["role"]) : null,
      content: d["content"] as String?,
      reasoning: reasoning,
      toolCalls: toolCalls,
    );

    if (first["finish_reason"] is String) {
      finishReason = first["finish_reason"] as String;
    }
  }

  final usage = toUsage(j["usage"]);
  if (first == null && usage == null) return null;

  return ChatChunk(
    id: j["id"] as String? ?? "",
    model: j["model"] as String? ?? providerModel,
    provider: providerLabel,
    delta: delta,
    finishReason: finishReason,
    usage: usage,
  );
}

class OpenAIAdapter implements ProviderAdapter {
  @override
  String get id => "openai";

  String labelFor(NormalizedRoute route) => providerLabel(route);
  String base(NormalizedRoute route) => _baseUrl(route);
  String chatEndpoint(NormalizedRoute route) => "${base(route)}/chat/completions";
  String embedEndpoint(NormalizedRoute route) => "${base(route)}/embeddings";
  String rawEndpoint(NormalizedRoute route, RawRequestOptions opts) =>
      "${base(route)}${opts.path ?? "/chat/completions"}";

  Map<String, String> authHeaders(NormalizedRoute route, String key) {
    if (route.authHeaderName != null) {
      return {route.authHeaderName!: key};
    }
    return {"authorization": "Bearer $key"};
  }

  List<String> optionNamespaces() => openAiOptionNamespaces;

  Map<String, dynamic> buildBody(ChatRequest req, String providerModel, bool stream) {
    final body = translateRequest(req, providerModel, stream);
    return mergeProviderOptions(body, req, optionNamespaces());
  }

  Future<http.Response> _send(
    Uri uri,
    Map<String, String> headers,
    Object? body,
    String label,
    AdapterContext ctx,
    int timeoutMs, {
    String method = "POST",
  }) async {
    final client = ctx.client ?? http.Client();
    try {
      final req = http.Request(method, uri);
      req.headers.addAll(headers);
      if (body != null) {
        req.body = body is String ? body : jsonEncode(body);
      }
      final streamedResponse = await client.send(req).timeout(
            Duration(milliseconds: timeoutMs),
          );
      return await http.Response.fromStream(streamedResponse);
    } catch (err) {
      throw toNetworkError(label, err);
    }
  }

  @override
  Future<http.Response> raw(
    NormalizedRoute route,
    String key,
    RawRequestOptions opts,
    AdapterContext ctx,
  ) async {
    final label = labelFor(route);
    final headers = {
      "content-type": "application/json",
      ...authHeaders(route, key),
      ...route.headers,
      if (opts.headers != null) ...opts.headers!,
    };
    return _send(
      Uri.parse(rawEndpoint(route, opts)),
      headers,
      opts.body,
      label,
      ctx,
      route.timeoutMs,
      method: opts.method ?? "POST",
    );
  }

  @override
  Future<ChatResponse> complete(
    NormalizedRoute route,
    String key,
    ChatRequest req,
    AdapterContext ctx,
  ) async {
    final label = labelFor(route);
    final headers = {
      "content-type": "application/json",
      ...authHeaders(route, key),
      ...route.headers,
    };
    final body = buildBody(req, route.model, false);
    final resp = await _send(
      Uri.parse(chatEndpoint(route)),
      headers,
      body,
      label,
      ctx,
      route.timeoutMs,
    );
    await requireOk(resp, label);
    final json = jsonDecode(resp.body);
    return translateResponse(json, route.model, label);
  }

  @override
  Future<Stream<ChatChunk>> stream(
    NormalizedRoute route,
    String key,
    ChatRequest req,
    AdapterContext ctx,
  ) async {
    final label = labelFor(route);
    final headers = {
      "content-type": "application/json",
      ...authHeaders(route, key),
      ...route.headers,
    };
    final body = buildBody(req, route.model, true);
    final client = ctx.client ?? http.Client();
    final request = http.Request("POST", Uri.parse(chatEndpoint(route)));
    request.headers.addAll(headers);
    request.body = jsonEncode(body);

    http.StreamedResponse streamedResponse;
    try {
      streamedResponse = await client.send(request).timeout(
            Duration(milliseconds: route.timeoutMs),
          );
    } catch (err) {
      throw toNetworkError(label, err);
    }

    if (streamedResponse.statusCode < 200 || streamedResponse.statusCode >= 300) {
      final resp = await http.Response.fromStream(streamedResponse);
      await requireOk(resp, label);
    }

    final model = route.model;

    Stream<ChatChunk> generator() async* {
      await for (final data in sseData(streamedResponse.stream)) {
        if (data == "[DONE]") return;
        Object? json;
        try {
          json = jsonDecode(data);
        } catch (_) {
          continue; // keep-alive or malformed line
        }

        if (json is Map && json["error"] is Map) {
          final errMap = json["error"] as Map;
          final msg = errMap["message"]?.toString() ?? "mid-stream error";
          throw ProviderError(label, ErrorKinds.server, "$label: $msg", body: json);
        }

        final chunk = translateChunk(json, model, label);
        if (chunk != null) {
          yield chunk;
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
    final label = labelFor(route);
    final headers = {
      "content-type": "application/json",
      ...authHeaders(route, key),
      ...route.headers,
    };
    final body = {"model": route.model, "input": req.input};
    final resp = await _send(
      Uri.parse(embedEndpoint(route)),
      headers,
      body,
      label,
      ctx,
      route.timeoutMs,
    );
    await requireOk(resp, label);
    final j = jsonDecode(resp.body) as Map<String, dynamic>;
    final raw = j["data"] is List ? j["data"] as List : <dynamic>[];
    final data = raw.asMap().entries.map((e) {
      final i = e.key;
      final d = e.value is Map ? Map<String, dynamic>.from(e.value as Map) : <String, dynamic>{};
      final emb = d["embedding"] is List
          ? (d["embedding"] as List).map((x) => (x as num).toDouble()).toList()
          : <double>[];
      return EmbeddingData(
        index: (d["index"] as num?)?.toInt() ?? i,
        embedding: emb,
      );
    }).toList();

    return EmbeddingResponse(
      object: "list",
      model: j["model"] as String? ?? route.model,
      provider: label,
      data: data,
      usage: toUsage(j["usage"]),
    );
  }
}
