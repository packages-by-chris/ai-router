import "dart:async";
import "dart:convert";
import "package:http/http.dart" as http;
import "../errors.dart";
import "../http/request.dart";
import "../http/sse.dart";
import "../types.dart";
import "gemini.dart";
import "types.dart";

String _vertexBaseUrl(NormalizedRoute route) {
  if (route.baseUrl != null && route.baseUrl!.isNotEmpty) {
    return route.baseUrl!.replaceAll(RegExp(r"/+$"), "");
  }
  if (route.region == null || route.region!.isEmpty) {
    throw ConfigError('route "${route.id}": vertex provider requires region');
  }
  return "https://${route.region}-aiplatform.googleapis.com/v1";
}

String _modelEndpoint(NormalizedRoute route, String action) {
  if (route.project == null || route.project!.isEmpty) {
    throw ConfigError('route "${route.id}": vertex provider requires project');
  }
  if (route.region == null || route.region!.isEmpty) {
    throw ConfigError('route "${route.id}": vertex provider requires region');
  }
  final base = _vertexBaseUrl(route);
  final project = Uri.encodeComponent(route.project!);
  final region = Uri.encodeComponent(route.region!);
  final model = Uri.encodeComponent(route.model);
  return "$base/projects/$project/locations/$region/publishers/google/models/$model:$action";
}

class VertexAdapter implements ProviderAdapter {
  @override
  String get id => "vertex";

  Map<String, String> _headers(NormalizedRoute route, String key) => {
        "content-type": "application/json",
        "authorization": "Bearer $key",
        ...route.headers,
      };

  @override
  Future<http.Response> raw(
    NormalizedRoute route,
    String key,
    RawRequestOptions opts,
    AdapterContext ctx,
  ) async {
    final defaultPath = _modelEndpoint(route, "generateContent");
    final url = opts.path != null
        ? "${_vertexBaseUrl(route)}${opts.path}"
        : defaultPath;
    final headers = {
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
      throw toNetworkError("vertex", err);
    }
  }

  @override
  Future<ChatResponse> complete(
    NormalizedRoute route,
    String key,
    ChatRequest req,
    AdapterContext ctx,
  ) async {
    final url = _modelEndpoint(route, "generateContent");
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
      throw toNetworkError("vertex", err);
    }

    await requireOk(resp, "vertex");
    final json = jsonDecode(resp.body);
    final chatResp = translateResponse(json, route.model);
    return chatResp.copyWith(provider: "vertex");
  }

  @override
  Future<Stream<ChatChunk>> stream(
    NormalizedRoute route,
    String key,
    ChatRequest req,
    AdapterContext ctx,
  ) async {
    final url = _modelEndpoint(route, "streamGenerateContent?alt=sse");
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
      throw toNetworkError("vertex", err);
    }

    if (streamedResponse.statusCode < 200 || streamedResponse.statusCode >= 300) {
      final resp = await http.Response.fromStream(streamedResponse);
      await requireOk(resp, "vertex");
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
              provider: "vertex",
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

        final candidates = ev["candidates"] is List ? ev["candidates"] as List : <dynamic>[];
        final candidate = candidates.isNotEmpty && candidates[0] is Map
            ? Map<String, dynamic>.from(candidates[0] as Map)
            : null;

        if (candidate != null) {
          final content = candidate["content"] is Map ? Map<String, dynamic>.from(candidate["content"] as Map) : <String, dynamic>{};
          final parts = content["parts"] is List ? content["parts"] as List : <dynamic>[];
          for (final part in parts) {
            if (part is! Map) continue;
            if (part["text"] is String && (part["text"] as String).isNotEmpty) {
              for (final c in ensureRole()) {
                yield c;
              }
              yield ChatChunk(
                id: "",
                model: servedModel,
                provider: "vertex",
                delta: Delta(content: part["text"] as String),
              );
            } else if (part["functionCall"] is Map) {
              for (final c in ensureRole()) {
                yield c;
              }
              final fc = part["functionCall"] as Map;
              final id = fc["id"] is String && (fc["id"] as String).isNotEmpty ? fc["id"] as String : null;
              yield ChatChunk(
                id: "",
                model: servedModel,
                provider: "vertex",
                delta: Delta(
                  toolCalls: [
                    ToolCallDelta(
                      index: 0,
                      id: id,
                      type: "function",
                      function: ToolCallDeltaFunction(
                        name: fc["name"] as String? ?? "",
                        arguments: jsonEncode(fc["args"] ?? {}),
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
      }

      if (finish != null || usage != null) {
        yield ChatChunk(
          id: "",
          model: servedModel,
          provider: "vertex",
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
    throw UnsupportedProviderError("vertex embedding is not supported");
  }
}
