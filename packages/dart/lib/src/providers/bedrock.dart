import "dart:async";
import "dart:convert";
import "dart:typed_data";
import "package:crypto/crypto.dart";
import "package:http/http.dart" as http;
import "../errors.dart";
import "../http/request.dart";
import "../types.dart";
import "types.dart";

class AwsCredentials {
  final String accessKeyId;
  final String secretAccessKey;
  final String? sessionToken;

  const AwsCredentials({
    required this.accessKeyId,
    required this.secretAccessKey,
    this.sessionToken,
  });
}

AwsCredentials parseAwsCredentials(String key) {
  final parts = key.split(":");
  if (parts.length < 2 || parts[0].isEmpty || parts[1].isEmpty) {
    throw ConfigError(
      'route: bedrock apiKey must be "ACCESS_KEY_ID:SECRET_ACCESS_KEY[:SESSION_TOKEN]"',
    );
  }
  return AwsCredentials(
    accessKeyId: parts[0],
    secretAccessKey: parts[1],
    sessionToken: parts.length > 2 && parts[2].isNotEmpty ? parts[2] : null,
  );
}

String _sha256Hex(List<int> data) {
  return sha256.convert(data).toString();
}

List<int> _hmacSha256(List<int> key, List<int> msg) {
  final h = Hmac(sha256, key);
  return h.convert(msg).bytes;
}

(String, String) _amzDate([DateTime? now]) {
  final dt = (now ?? DateTime.now()).toUtc();
  final y = dt.year.toString().padLeft(4, "0");
  final m = dt.month.toString().padLeft(2, "0");
  final d = dt.day.toString().padLeft(2, "0");
  final h = dt.hour.toString().padLeft(2, "0");
  final min = dt.minute.toString().padLeft(2, "0");
  final s = dt.second.toString().padLeft(2, "0");

  final date = "$y$m$d";
  final amz = "${date}T$h$min${s}Z";
  return (amz, date);
}

Map<String, String> sigv4Headers({
  required String method,
  required String url,
  required List<int> body,
  required AwsCredentials credentials,
  required String region,
  String service = "bedrock",
  DateTime? now,
}) {
  final uriObj = Uri.parse(url);
  final (amz, date) = _amzDate(now);

  final canonicalPath = uriObj.pathSegments.map(Uri.encodeComponent).join("/");
  final uri = "/$canonicalPath";

  final host = uriObj.host;
  final canonicalHeaders = "content-type:application/json\nhost:$host\nx-amz-date:$amz\n${credentials.sessionToken != null ? "x-amz-security-token:${credentials.sessionToken}\n" : ""}";
  final signedHeaders = "content-type;host;x-amz-date${credentials.sessionToken != null ? ";x-amz-security-token" : ""}";

  final payloadHash = _sha256Hex(body);
  final canonicalRequest = [
    method,
    uri,
    "", // query params
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  final scope = "$date/$region/$service/aws4_request";
  final stringToSign = [
    "AWS4-HMAC-SHA256",
    amz,
    scope,
    _sha256Hex(utf8.encode(canonicalRequest)),
  ].join("\n");

  final kDate = _hmacSha256(utf8.encode("AWS4${credentials.secretAccessKey}"), utf8.encode(date));
  final kRegion = _hmacSha256(kDate, utf8.encode(region));
  final kService = _hmacSha256(kRegion, utf8.encode(service));
  final kSigning = _hmacSha256(kService, utf8.encode("aws4_request"));

  final signatureBytes = _hmacSha256(kSigning, utf8.encode(stringToSign));
  final signature = signatureBytes.map((b) => b.toRadixString(16).padLeft(2, "0")).join();

  final headers = <String, String>{
    "content-type": "application/json",
    "x-amz-date": amz,
    "authorization":
        "AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/$scope, SignedHeaders=$signedHeaders, Signature=$signature",
  };
  if (credentials.sessionToken != null) {
    headers["x-amz-security-token"] = credentials.sessionToken!;
  }
  return headers;
}

String _baseUrl(NormalizedRoute route) {
  if (route.baseUrl != null && route.baseUrl!.isNotEmpty) {
    return route.baseUrl!.replaceAll(RegExp(r"/+$"), "");
  }
  if (route.region == null || route.region!.isEmpty) {
    throw ConfigError('route "${route.id}": bedrock provider requires region');
  }
  return "https://bedrock-runtime.${route.region}.amazonaws.com";
}

String? mapBedrockStopReason(Object? stopReason) {
  if (stopReason == null) return null;
  final str = stopReason.toString();
  switch (str) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "content_filtered":
    case "guardrail_intervened":
      return "content_filter";
    default:
      return str;
  }
}

const Map<String, String> _imageFormats = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
};

Map<String, dynamic>? _imageBlock(String url) {
  final dataUri = RegExp(r"^data:([^;,]+);base64,(.*)$", caseSensitive: false).firstMatch(url);
  if (dataUri == null) return null;
  final mime = dataUri.group(1)!.toLowerCase();
  final fmt = _imageFormats[mime];
  if (fmt == null) return null;
  return <String, dynamic>{
    "image": <String, dynamic>{
      "format": fmt,
      "source": <String, dynamic>{"bytes": dataUri.group(2)!}
    }
  };
}

void _pushUnifiedContent(
  void Function(String role, Map<String, dynamic> block) push,
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

class _BedrockTurn {
  final String role;
  final List<Map<String, dynamic>> content;
  _BedrockTurn(this.role, this.content);
}

Map<String, dynamic> translateRequest(
  ChatRequest req,
  String providerModel,
  bool stream,
) {
  final systemParts = <String>[];
  final turns = <_BedrockTurn>[];

  void push(String role, Map<String, dynamic> block) {
    if (turns.isNotEmpty && turns.last.role == role) {
      turns.last.content.add(block);
    } else {
      turns.add(_BedrockTurn(role, <Map<String, dynamic>>[block]));
    }
  }

  for (final msg in req.messages) {
    if (msg.role == Roles.system) {
      if (msg.content is String) {
        final str = msg.content as String;
        if (str.isNotEmpty) systemParts.add(str);
      } else if (msg.content is List) {
        for (final p in msg.content as List) {
          final text = p is TextPart ? p.text : (p is Map && p["type"] == "text" ? p["text"] as String? : null);
          if (text != null && text.isNotEmpty) systemParts.add(text);
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
            .map<String>((p) => p is TextPart ? p.text : (p is Map && p["type"] == "text" ? (p["text"] as String? ?? "") : ""))
            .where((String s) => s.isNotEmpty)
            .join("\n");
      }
      push("user", <String, dynamic>{
        "toolResult": <String, dynamic>{
          "toolUseId": msg.toolCallId ?? "",
          "content": <Map<String, dynamic>>[
            <String, dynamic>{"text": resultText}
          ]
        }
      });
      continue;
    }

    final role = msg.role == Roles.assistant ? "assistant" : "user";
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
          "toolUse": <String, dynamic>{
            "toolUseId": tc.id,
            "name": tc.function.name,
            "input": args,
          }
        });
      }
    }
  }

  final body = <String, dynamic>{
    "messages": turns.map((t) => <String, dynamic>{"role": t.role, "content": t.content}).toList(),
  };

  if (systemParts.isNotEmpty) {
    body["system"] = <Map<String, dynamic>>[
      <String, dynamic>{"text": systemParts.join("\n\n")}
    ];
  }

  final inferenceConfig = <String, dynamic>{};
  if (req.temperature != null) inferenceConfig["temperature"] = req.temperature;
  if (req.topP != null) inferenceConfig["topP"] = req.topP;
  if (req.maxTokens != null) inferenceConfig["maxTokens"] = req.maxTokens;
  if (req.stop != null) {
    inferenceConfig["stopSequences"] = req.stop is List ? req.stop : <dynamic>[req.stop];
  }
  if (inferenceConfig.isNotEmpty) {
    body["inferenceConfig"] = inferenceConfig;
  }

  final sendTools = req.toolChoice != "none" && req.tools != null && req.tools!.isNotEmpty;
  if (sendTools) {
    final bedrockTools = req.tools!.map((t) {
      final spec = <String, dynamic>{
        "name": t.function.name,
        "inputSchema": <String, dynamic>{"json": t.function.parameters},
      };
      if (t.function.description != null) {
        spec["description"] = t.function.description;
      }
      return <String, dynamic>{"toolSpec": spec};
    }).toList();

    final toolConfig = <String, dynamic>{"tools": bedrockTools};
    final choice = req.toolChoice;
    if (choice == "auto") {
      toolConfig["toolChoice"] = <String, dynamic>{"auto": <String, dynamic>{}};
    } else if (choice == "required") {
      toolConfig["toolChoice"] = <String, dynamic>{"any": <String, dynamic>{}};
    } else if (choice is Map && choice["function"] is Map) {
      toolConfig["toolChoice"] = <String, dynamic>{
        "tool": <String, dynamic>{"name": (choice["function"] as Map)["name"]}
      };
    }
    body["toolConfig"] = toolConfig;
  }

  final extra = req.providerOptions?["bedrock"];
  if (extra != null) {
    body.addAll(extra);
  }

  return body;
}

Usage? _toUsage(Object? v) {
  if (v is! Map) return null;
  final u = Map<String, dynamic>.from(v);
  final inp = u["inputTokens"];
  final out = u["outputTokens"];
  if (inp is! num || out is! num) return null;
  final inTok = inp.toInt();
  final outTok = out.toInt();
  final total = u["totalTokens"] is num ? (u["totalTokens"] as num).toInt() : inTok + outTok;
  final cacheRead = (u["cacheReadInputTokens"] as num?)?.toInt() ?? 0;
  final cacheWrite = (u["cacheWriteInputTokens"] as num?)?.toInt() ?? 0;
  return Usage(
    promptTokens: inTok,
    completionTokens: outTok,
    totalTokens: total,
    cachedTokens: cacheRead > 0 ? cacheRead : null,
    cacheWriteTokens: cacheWrite > 0 ? cacheWrite : null,
  );
}

ChatResponse translateResponse(Object? json, String providerModel) {
  final j = json is Map ? Map<String, dynamic>.from(json) : <String, dynamic>{};
  final output = j["output"] is Map ? Map<String, dynamic>.from(j["output"] as Map) : <String, dynamic>{};
  final message = output["message"] is Map ? Map<String, dynamic>.from(output["message"] as Map) : <String, dynamic>{};
  final blocks = message["content"] is List ? message["content"] as List : <dynamic>[];

  String text = "";
  String reasoning = "";
  final toolCalls = <ToolCall>[];

  for (final block in blocks) {
    if (block is! Map) continue;
    if (block["text"] is String) {
      text += block["text"] as String;
    } else if (block["reasoningContent"] is Map) {
      final rc = block["reasoningContent"] as Map;
      if (rc["text"] is String) reasoning += rc["text"] as String;
    } else if (block["toolUse"] is Map) {
      final tu = block["toolUse"] as Map;
      toolCalls.add(ToolCall(
        id: tu["toolUseId"] as String? ?? "",
        type: "function",
        function: ToolCallFunction(
          name: tu["name"] as String? ?? "",
          arguments: jsonEncode(tu["input"] ?? <String, dynamic>{}),
        ),
      ));
    }
  }

  return ChatResponse(
    id: j["messageId"] as String? ?? "",
    model: providerModel,
    provider: "bedrock",
    created: 0,
    usage: _toUsage(j["usage"]),
    choices: [
      Choice(
        index: 0,
        finishReason: mapBedrockStopReason(j["stopReason"]),
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

class BedrockAdapter implements ProviderAdapter {
  @override
  String get id => "bedrock";

  String converseUrl(NormalizedRoute route, String action) {
    final encodedModel = Uri.encodeComponent(route.model);
    return "${_baseUrl(route)}/model/$encodedModel/$action";
  }

  @override
  Future<http.Response> raw(
    NormalizedRoute route,
    String key,
    RawRequestOptions opts,
    AdapterContext ctx,
  ) async {
    if (route.region == null || route.region!.isEmpty) {
      throw ConfigError('route "${route.id}": bedrock provider requires region');
    }
    final url = converseUrl(route, "converse");
    final bodyBytes = utf8.encode(opts.body != null
        ? (opts.body is String ? opts.body as String : jsonEncode(opts.body))
        : "{}");
    final creds = parseAwsCredentials(key);
    final headers = sigv4Headers(
      method: opts.method ?? "POST",
      url: url,
      body: bodyBytes,
      credentials: creds,
      region: route.region!,
    );
    if (opts.headers != null) headers.addAll(opts.headers!);

    final client = ctx.client ?? http.Client();
    try {
      final req = http.Request(opts.method ?? "POST", Uri.parse(url));
      req.headers.addAll(headers);
      req.bodyBytes = bodyBytes;
      final streamResp = await client.send(req).timeout(
            Duration(milliseconds: route.timeoutMs),
          );
      return await http.Response.fromStream(streamResp);
    } catch (err) {
      throw toNetworkError("bedrock", err);
    }
  }

  @override
  Future<ChatResponse> complete(
    NormalizedRoute route,
    String key,
    ChatRequest req,
    AdapterContext ctx,
  ) async {
    if (route.region == null || route.region!.isEmpty) {
      throw ConfigError('route "${route.id}": bedrock provider requires region');
    }
    final url = converseUrl(route, "converse");
    final body = translateRequest(req, route.model, false);
    final bodyBytes = utf8.encode(jsonEncode(body));
    final creds = parseAwsCredentials(key);
    final headers = sigv4Headers(
      method: "POST",
      url: url,
      body: bodyBytes,
      credentials: creds,
      region: route.region!,
    );
    headers.addAll(route.headers);

    final client = ctx.client ?? http.Client();
    http.Response resp;
    try {
      final request = http.Request("POST", Uri.parse(url));
      request.headers.addAll(headers);
      request.bodyBytes = bodyBytes;
      final streamResp = await client.send(request).timeout(
            Duration(milliseconds: route.timeoutMs),
          );
      resp = await http.Response.fromStream(streamResp);
    } catch (err) {
      throw toNetworkError("bedrock", err);
    }

    await requireOk(resp, "bedrock");
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
    // Bedrock Converse-stream returns binary AWS event-stream framing
    if (route.region == null || route.region!.isEmpty) {
      throw ConfigError('route "${route.id}": bedrock provider requires region');
    }
    final url = converseUrl(route, "converse-stream");
    final body = translateRequest(req, route.model, true);
    final bodyBytes = utf8.encode(jsonEncode(body));
    final creds = parseAwsCredentials(key);
    final headers = sigv4Headers(
      method: "POST",
      url: url,
      body: bodyBytes,
      credentials: creds,
      region: route.region!,
    );
    headers.addAll(route.headers);

    final client = ctx.client ?? http.Client();
    final request = http.Request("POST", Uri.parse(url));
    request.headers.addAll(headers);
    request.bodyBytes = bodyBytes;

    http.StreamedResponse streamedResponse;
    try {
      streamedResponse = await client.send(request).timeout(
            Duration(milliseconds: route.timeoutMs),
          );
    } catch (err) {
      throw toNetworkError("bedrock", err);
    }

    if (streamedResponse.statusCode < 200 || streamedResponse.statusCode >= 300) {
      final resp = await http.Response.fromStream(streamedResponse);
      await requireOk(resp, "bedrock");
    }

    final model = route.model;

    Stream<ChatChunk> generator() async* {
      // Decode event-stream binary chunks
      final buffer = <int>[];
      String servedModel = model;
      String? finish;
      Usage? usage;

      await for (final chunk in streamedResponse.stream) {
        buffer.addAll(chunk);
        while (buffer.length >= 12) {
          final byteData = ByteData.sublistView(Uint8List.fromList(buffer));
          final totalLen = byteData.getUint32(0);
          final headersLen = byteData.getUint32(4);

          if (buffer.length < totalLen) break;

          final payloadStart = 12 + headersLen;
          final payloadEnd = totalLen - 4; // CRC-32 is last 4 bytes
          if (payloadStart <= payloadEnd) {
            final payloadBytes = buffer.sublist(payloadStart, payloadEnd);
            final payloadText = utf8.decode(payloadBytes, allowMalformed: true);
            try {
              final json = jsonDecode(payloadText);
              if (json is Map) {
                if (json["contentBlockDelta"] is Map) {
                  final cbd = json["contentBlockDelta"] as Map;
                  final delta = cbd["delta"] is Map ? cbd["delta"] as Map : <String, dynamic>{};
                  if (delta["text"] is String) {
                    yield ChatChunk(
                      id: "",
                      model: servedModel,
                      provider: "bedrock",
                      delta: Delta(content: delta["text"] as String),
                    );
                  } else if (delta["reasoningContent"] is Map) {
                    final rc = delta["reasoningContent"] as Map;
                    if (rc["text"] is String) {
                      yield ChatChunk(
                        id: "",
                        model: servedModel,
                        provider: "bedrock",
                        delta: Delta(reasoning: rc["text"] as String),
                      );
                    }
                  } else if (delta["toolUse"] is Map) {
                    final tu = delta["toolUse"] as Map;
                    yield ChatChunk(
                      id: "",
                      model: servedModel,
                      provider: "bedrock",
                      delta: Delta(
                        toolCalls: [
                          ToolCallDelta(
                            index: (cbd["contentBlockIndex"] as num?)?.toInt() ?? 0,
                            function: ToolCallDeltaFunction(
                              arguments: tu["input"]?.toString() ?? "",
                            ),
                          ),
                        ],
                      ),
                    );
                  }
                } else if (json["messageStop"] is Map) {
                  final ms = json["messageStop"] as Map;
                  if (ms["stopReason"] != null) {
                    finish = mapBedrockStopReason(ms["stopReason"]);
                  }
                } else if (json["metadata"] is Map) {
                  final md = json["metadata"] as Map;
                  if (md["usage"] != null) {
                    usage = _toUsage(md["usage"]);
                  }
                }
              }
            } catch (_) {}
          }

          buffer.removeRange(0, totalLen);
        }
      }

      if (finish != null || usage != null) {
        yield ChatChunk(
          id: "",
          model: servedModel,
          provider: "bedrock",
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
    throw UnsupportedProviderError("bedrock embedding via Converse is not supported");
  }
}
