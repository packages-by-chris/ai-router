/// Unified request/response types.
///
/// The unified surface intentionally mirrors the OpenAI chat-completions shape
/// (the de facto lingua franca) so that translation layers stay thin and the
/// raw escape hatch stays natural. Provider adapters translate both directions.

typedef Role = String;

class Roles {
  static const String system = "system";
  static const String user = "user";
  static const String assistant = "assistant";
  static const String tool = "tool";
}

class ToolCallFunction {
  final String name;
  final String arguments;

  const ToolCallFunction({
    required this.name,
    required this.arguments,
  });

  factory ToolCallFunction.fromJson(Map<String, dynamic> json) => ToolCallFunction(
        name: json["name"] as String? ?? "",
        arguments: json["arguments"] as String? ?? "",
      );

  Map<String, dynamic> toJson() => {
        "name": name,
        "arguments": arguments,
      };
}

class ToolCall {
  final String id;
  final String type; // "function"
  final ToolCallFunction function;

  const ToolCall({
    required this.id,
    this.type = "function",
    required this.function,
  });

  factory ToolCall.fromJson(Map<String, dynamic> json) {
    final fn = json["function"];
    return ToolCall(
      id: json["id"] as String? ?? "",
      type: json["type"] as String? ?? "function",
      function: fn is Map<String, dynamic>
          ? ToolCallFunction.fromJson(fn)
          : const ToolCallFunction(name: "", arguments: ""),
    );
  }

  Map<String, dynamic> toJson() => {
        "id": id,
        "type": type,
        "function": function.toJson(),
      };
}

/// Unified multimodal content parts (OpenAI-style shapes as the base).
abstract class ContentPart {
  final String type;
  const ContentPart(this.type);

  Map<String, dynamic> toJson();

  static ContentPart fromJson(Map<String, dynamic> json) {
    final type = json["type"] as String? ?? "text";
    if (type == "image_url") {
      final img = json["image_url"] as Map<String, dynamic>? ?? {};
      return ImageUrlPart(
        url: img["url"] as String? ?? "",
        detail: img["detail"] as String?,
      );
    }
    return TextPart(json["text"] as String? ?? "");
  }
}

class TextPart extends ContentPart {
  final String text;

  const TextPart(this.text) : super("text");

  @override
  Map<String, dynamic> toJson() => {
        "type": "text",
        "text": text,
      };
}

class ImageUrlPart extends ContentPart {
  final String url;
  final String? detail; // "auto" | "low" | "high"

  const ImageUrlPart({
    required this.url,
    this.detail,
  }) : super("image_url");

  @override
  Map<String, dynamic> toJson() => {
        "type": "image_url",
        "image_url": {
          "url": url,
          if (detail != null) "detail": detail,
        },
      };
}

class ChatMessage {
  final Role role;
  /// Plain text, or multimodal parts (user messages). Can be String, List<ContentPart>, or null.
  final Object? content;
  final String? name;
  final List<ToolCall>? toolCalls;
  final String? toolCallId;
  final String? reasoning;
  final Map<String, Map<String, dynamic>>? providerOptions;

  const ChatMessage({
    required this.role,
    this.content,
    this.name,
    this.toolCalls,
    this.toolCallId,
    this.reasoning,
    this.providerOptions,
  });

  factory ChatMessage.fromJson(Map<String, dynamic> json) {
    final rawContent = json["content"];
    Object? parsedContent;
    if (rawContent is String || rawContent == null) {
      parsedContent = rawContent;
    } else if (rawContent is List) {
      parsedContent = rawContent.map((item) {
        if (item is Map<String, dynamic>) {
          return ContentPart.fromJson(item);
        } else if (item is ContentPart) {
          return item;
        }
        return TextPart(item.toString());
      }).toList();
    } else {
      parsedContent = rawContent.toString();
    }

    final rawToolCalls = json["tool_calls"];
    List<ToolCall>? toolCalls;
    if (rawToolCalls is List) {
      toolCalls = rawToolCalls
          .map((tc) => tc is Map<String, dynamic>
              ? ToolCall.fromJson(tc)
              : tc is ToolCall
                  ? tc
                  : null)
          .whereType<ToolCall>()
          .toList();
    }

    Map<String, Map<String, dynamic>>? provOpts;
    if (json["providerOptions"] is Map) {
      provOpts = {};
      final map = json["providerOptions"] as Map;
      for (final entry in map.entries) {
        if (entry.value is Map) {
          provOpts[entry.key.toString()] =
              Map<String, dynamic>.from(entry.value as Map);
        }
      }
    }

    return ChatMessage(
      role: json["role"] as String? ?? Roles.user,
      content: parsedContent,
      name: json["name"] as String?,
      toolCalls: toolCalls,
      toolCallId: json["tool_call_id"] as String?,
      reasoning: json["reasoning"] as String?,
      providerOptions: provOpts,
    );
  }

  Map<String, dynamic> toJson() {
    Object? contentJson;
    if (content is List) {
      contentJson = (content as List).map((part) {
        if (part is ContentPart) return part.toJson();
        if (part is Map) return part;
        return {"type": "text", "text": part.toString()};
      }).toList();
    } else {
      contentJson = content;
    }

    return {
      "role": role,
      if (content != null || role == Roles.assistant) "content": contentJson,
      if (name != null) "name": name,
      if (toolCalls != null)
        "tool_calls": toolCalls!.map((tc) => tc.toJson()).toList(),
      if (toolCallId != null) "tool_call_id": toolCallId,
      if (reasoning != null) "reasoning": reasoning,
      if (providerOptions != null) "providerOptions": providerOptions,
    };
  }
}

class ToolFunction {
  final String name;
  final String? description;
  final Map<String, dynamic> parameters;

  const ToolFunction({
    required this.name,
    this.description,
    required this.parameters,
  });

  factory ToolFunction.fromJson(Map<String, dynamic> json) => ToolFunction(
        name: json["name"] as String? ?? "",
        description: json["description"] as String?,
        parameters: json["parameters"] is Map
            ? Map<String, dynamic>.from(json["parameters"] as Map)
            : {},
      );

  Map<String, dynamic> toJson() => {
        "name": name,
        if (description != null) "description": description,
        "parameters": parameters,
      };
}

class Tool {
  final String type; // "function"
  final ToolFunction function;

  const Tool({
    this.type = "function",
    required this.function,
  });

  factory Tool.fromJson(Map<String, dynamic> json) {
    final fn = json["function"];
    return Tool(
      type: json["type"] as String? ?? "function",
      function: fn is Map<String, dynamic>
          ? ToolFunction.fromJson(fn)
          : const ToolFunction(name: "", parameters: {}),
    );
  }

  Map<String, dynamic> toJson() => {
        "type": type,
        "function": function.toJson(),
      };
}

abstract class ResponseFormat {
  final String type;
  const ResponseFormat(this.type);

  Map<String, dynamic> toJson();

  static ResponseFormat fromJson(Map<String, dynamic> json) {
    final type = json["type"] as String? ?? "text";
    if (type == "json_object") return const JsonObjectResponseFormat();
    if (type == "json_schema") {
      final js = json["json_schema"] as Map<String, dynamic>? ?? {};
      return JsonSchemaResponseFormat(
        name: js["name"] as String?,
        schema: js["schema"] is Map ? Map<String, dynamic>.from(js["schema"] as Map) : {},
        strict: js["strict"] as bool?,
      );
    }
    return const TextResponseFormat();
  }
}

class TextResponseFormat extends ResponseFormat {
  const TextResponseFormat() : super("text");

  @override
  Map<String, dynamic> toJson() => {"type": "text"};
}

class JsonObjectResponseFormat extends ResponseFormat {
  const JsonObjectResponseFormat() : super("json_object");

  @override
  Map<String, dynamic> toJson() => {"type": "json_object"};
}

class JsonSchemaResponseFormat extends ResponseFormat {
  final String? name;
  final Map<String, dynamic> schema;
  final bool? strict;

  const JsonSchemaResponseFormat({
    this.name,
    required this.schema,
    this.strict,
  }) : super("json_schema");

  @override
  Map<String, dynamic> toJson() => {
        "type": "json_schema",
        "json_schema": {
          if (name != null) "name": name,
          "schema": schema,
          if (strict != null) "strict": strict,
        },
      };
}

typedef ProviderOptions = Map<String, Map<String, dynamic>>;

/// Logical request. `model` is a route id from the config, not a provider model name.
class ChatRequest {
  final String model;
  final List<ChatMessage> messages;
  final List<Tool>? tools;
  /// "none" | "auto" | "required" | Map/ToolChoice object
  final Object? toolChoice;
  final double? temperature;
  final double? topP;
  final int? maxTokens;
  /// String or List<String>
  final Object? stop;
  final ResponseFormat? responseFormat;
  /// "low" | "medium" | "high"
  final String? reasoningEffort;
  final ProviderOptions? providerOptions;
  final String? user;

  const ChatRequest({
    required this.model,
    required this.messages,
    this.tools,
    this.toolChoice,
    this.temperature,
    this.topP,
    this.maxTokens,
    this.stop,
    this.responseFormat,
    this.reasoningEffort,
    this.providerOptions,
    this.user,
  });

  factory ChatRequest.fromJson(Map<String, dynamic> json) {
    final rawMsgs = json["messages"] as List? ?? [];
    final msgs = rawMsgs
        .map((m) => m is Map<String, dynamic>
            ? ChatMessage.fromJson(m)
            : m is ChatMessage
                ? m
                : null)
        .whereType<ChatMessage>()
        .toList();

    final rawTools = json["tools"] as List?;
    final tools = rawTools
        ?.map((t) => t is Map<String, dynamic>
            ? Tool.fromJson(t)
            : t is Tool
                ? t
                : null)
        .whereType<Tool>()
        .toList();

    ResponseFormat? respFormat;
    if (json["response_format"] is Map) {
      respFormat =
          ResponseFormat.fromJson(json["response_format"] as Map<String, dynamic>);
    }

    ProviderOptions? provOpts;
    if (json["providerOptions"] is Map) {
      provOpts = {};
      final map = json["providerOptions"] as Map;
      for (final entry in map.entries) {
        if (entry.value is Map) {
          provOpts[entry.key.toString()] =
              Map<String, dynamic>.from(entry.value as Map);
        }
      }
    }

    return ChatRequest(
      model: json["model"] as String? ?? "",
      messages: msgs,
      tools: tools,
      toolChoice: json["tool_choice"],
      temperature: (json["temperature"] as num?)?.toDouble(),
      topP: (json["top_p"] as num?)?.toDouble(),
      maxTokens: json["max_tokens"] as int?,
      stop: json["stop"],
      responseFormat: respFormat,
      reasoningEffort: json["reasoning_effort"] as String?,
      providerOptions: provOpts,
      user: json["user"] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
        "model": model,
        "messages": messages.map((m) => m.toJson()).toList(),
        if (tools != null) "tools": tools!.map((t) => t.toJson()).toList(),
        if (toolChoice != null) "tool_choice": toolChoice,
        if (temperature != null) "temperature": temperature,
        if (topP != null) "top_p": topP,
        if (maxTokens != null) "max_tokens": maxTokens,
        if (stop != null) "stop": stop,
        if (responseFormat != null) "response_format": responseFormat!.toJson(),
        if (reasoningEffort != null) "reasoning_effort": reasoningEffort,
        if (providerOptions != null) "providerOptions": providerOptions,
        if (user != null) "user": user,
      };

  ChatRequest copyWith({
    String? model,
    List<ChatMessage>? messages,
    List<Tool>? tools,
    Object? toolChoice,
    double? temperature,
    double? topP,
    int? maxTokens,
    Object? stop,
    ResponseFormat? responseFormat,
    String? reasoningEffort,
    ProviderOptions? providerOptions,
    String? user,
  }) {
    return ChatRequest(
      model: model ?? this.model,
      messages: messages ?? this.messages,
      tools: tools ?? this.tools,
      toolChoice: toolChoice ?? this.toolChoice,
      temperature: temperature ?? this.temperature,
      topP: topP ?? this.topP,
      maxTokens: maxTokens ?? this.maxTokens,
      stop: stop ?? this.stop,
      responseFormat: responseFormat ?? this.responseFormat,
      reasoningEffort: reasoningEffort ?? this.reasoningEffort,
      providerOptions: providerOptions ?? this.providerOptions,
      user: user ?? this.user,
    );
  }
}

class Usage {
  final int promptTokens;
  final int completionTokens;
  final int totalTokens;
  final int? cachedTokens;
  final int? cacheWriteTokens;
  final int? reasoningTokens;

  const Usage({
    required this.promptTokens,
    required this.completionTokens,
    required this.totalTokens,
    this.cachedTokens,
    this.cacheWriteTokens,
    this.reasoningTokens,
  });

  factory Usage.fromJson(Map<String, dynamic> json) => Usage(
        promptTokens: json["prompt_tokens"] as int? ?? 0,
        completionTokens: json["completion_tokens"] as int? ?? 0,
        totalTokens: json["total_tokens"] as int? ?? 0,
        cachedTokens: json["cached_tokens"] as int?,
        cacheWriteTokens: json["cache_write_tokens"] as int?,
        reasoningTokens: json["reasoning_tokens"] as int?,
      );

  Map<String, dynamic> toJson() => {
        "prompt_tokens": promptTokens,
        "completion_tokens": completionTokens,
        "total_tokens": totalTokens,
        if (cachedTokens != null) "cached_tokens": cachedTokens,
        if (cacheWriteTokens != null) "cache_write_tokens": cacheWriteTokens,
        if (reasoningTokens != null) "reasoning_tokens": reasoningTokens,
      };
}

class TokenPrice {
  final double input;
  final double output;
  final double? cacheRead;
  final double? cacheWrite;

  const TokenPrice({
    required this.input,
    required this.output,
    this.cacheRead,
    this.cacheWrite,
  });

  factory TokenPrice.fromJson(Map<String, dynamic> json) => TokenPrice(
        input: (json["input"] as num).toDouble(),
        output: (json["output"] as num).toDouble(),
        cacheRead: (json["cache_read"] as num?)?.toDouble(),
        cacheWrite: (json["cache_write"] as num?)?.toDouble(),
      );

  Map<String, dynamic> toJson() => {
        "input": input,
        "output": output,
        if (cacheRead != null) "cache_read": cacheRead,
        if (cacheWrite != null) "cache_write": cacheWrite,
      };
}

class Choice {
  final int index;
  final ChatMessage message;
  final String? finishReason;

  const Choice({
    required this.index,
    required this.message,
    this.finishReason,
  });

  factory Choice.fromJson(Map<String, dynamic> json) => Choice(
        index: json["index"] as int? ?? 0,
        message: ChatMessage.fromJson(json["message"] as Map<String, dynamic>? ?? {}),
        finishReason: json["finish_reason"] as String?,
      );

  Map<String, dynamic> toJson() => {
        "index": index,
        "message": message.toJson(),
        "finish_reason": finishReason,
      };
}

class ChatResponse {
  final String id;
  final String model;
  final String provider;
  final int created;
  final List<Choice> choices;
  final Usage? usage;
  final double? costUsd;

  const ChatResponse({
    required this.id,
    required this.model,
    required this.provider,
    required this.created,
    required this.choices,
    this.usage,
    this.costUsd,
  });

  factory ChatResponse.fromJson(Map<String, dynamic> json) {
    final rawChoices = json["choices"] as List? ?? [];
    return ChatResponse(
      id: json["id"] as String? ?? "",
      model: json["model"] as String? ?? "",
      provider: json["provider"] as String? ?? "",
      created: json["created"] as int? ?? 0,
      choices: rawChoices
          .map((c) => c is Map<String, dynamic> ? Choice.fromJson(c) : null)
          .whereType<Choice>()
          .toList(),
      usage: json["usage"] is Map<String, dynamic>
          ? Usage.fromJson(json["usage"] as Map<String, dynamic>)
          : null,
      costUsd: (json["cost_usd"] as num?)?.toDouble(),
    );
  }

  Map<String, dynamic> toJson() => {
        "id": id,
        "model": model,
        "provider": provider,
        "created": created,
        "choices": choices.map((c) => c.toJson()).toList(),
        "usage": usage?.toJson(),
        if (costUsd != null) "cost_usd": costUsd,
      };

  ChatResponse copyWith({
    String? id,
    String? model,
    String? provider,
    int? created,
    List<Choice>? choices,
    Usage? usage,
    double? costUsd,
  }) {
    return ChatResponse(
      id: id ?? this.id,
      model: model ?? this.model,
      provider: provider ?? this.provider,
      created: created ?? this.created,
      choices: choices ?? this.choices,
      usage: usage ?? this.usage,
      costUsd: costUsd ?? this.costUsd,
    );
  }
}

class ToolCallDeltaFunction {
  final String? name;
  final String? arguments;

  const ToolCallDeltaFunction({this.name, this.arguments});

  factory ToolCallDeltaFunction.fromJson(Map<String, dynamic> json) =>
      ToolCallDeltaFunction(
        name: json["name"] as String?,
        arguments: json["arguments"] as String?,
      );

  Map<String, dynamic> toJson() => {
        if (name != null) "name": name,
        if (arguments != null) "arguments": arguments,
      };
}

class ToolCallDelta {
  final int index;
  final String? id;
  final String? type;
  final ToolCallDeltaFunction? function;

  const ToolCallDelta({
    required this.index,
    this.id,
    this.type,
    this.function,
  });

  factory ToolCallDelta.fromJson(Map<String, dynamic> json) => ToolCallDelta(
        index: json["index"] as int? ?? 0,
        id: json["id"] as String?,
        type: json["type"] as String?,
        function: json["function"] is Map<String, dynamic>
            ? ToolCallDeltaFunction.fromJson(
                json["function"] as Map<String, dynamic>)
            : null,
      );

  Map<String, dynamic> toJson() => {
        "index": index,
        if (id != null) "id": id,
        if (type != null) "type": type,
        if (function != null) "function": function!.toJson(),
      };
}

class Delta {
  final Role? role;
  final String? content;
  final String? reasoning;
  final List<ToolCallDelta>? toolCalls;

  const Delta({
    this.role,
    this.content,
    this.reasoning,
    this.toolCalls,
  });

  factory Delta.fromJson(Map<String, dynamic> json) {
    final rawToolCalls = json["tool_calls"] as List?;
    return Delta(
      role: json["role"] as String?,
      content: json["content"] as String?,
      reasoning: json["reasoning"] as String?,
      toolCalls: rawToolCalls
          ?.map((tc) =>
              tc is Map<String, dynamic> ? ToolCallDelta.fromJson(tc) : null)
          .whereType<ToolCallDelta>()
          .toList(),
    );
  }

  Map<String, dynamic> toJson() => {
        if (role != null) "role": role,
        if (content != null) "content": content,
        if (reasoning != null) "reasoning": reasoning,
        if (toolCalls != null)
          "tool_calls": toolCalls!.map((tc) => tc.toJson()).toList(),
      };
}

class ChatChunk {
  final String id;
  final String model;
  final String provider;
  final Delta delta;
  final String? finishReason;
  final Usage? usage;
  final double? costUsd;

  const ChatChunk({
    required this.id,
    required this.model,
    required this.provider,
    required this.delta,
    this.finishReason,
    this.usage,
    this.costUsd,
  });

  factory ChatChunk.fromJson(Map<String, dynamic> json) => ChatChunk(
        id: json["id"] as String? ?? "",
        model: json["model"] as String? ?? "",
        provider: json["provider"] as String? ?? "",
        delta: json["delta"] is Map<String, dynamic>
            ? Delta.fromJson(json["delta"] as Map<String, dynamic>)
            : const Delta(),
        finishReason: json["finish_reason"] as String?,
        usage: json["usage"] is Map<String, dynamic>
            ? Usage.fromJson(json["usage"] as Map<String, dynamic>)
            : null,
        costUsd: (json["cost_usd"] as num?)?.toDouble(),
      );

  Map<String, dynamic> toJson() => {
        "id": id,
        "model": model,
        "provider": provider,
        "delta": delta.toJson(),
        "finish_reason": finishReason,
        if (usage != null) "usage": usage!.toJson(),
        if (costUsd != null) "cost_usd": costUsd,
      };
}

// ---------------------------------------------------------------- embeddings

class EmbeddingRequest {
  final String model;
  /// String or List<String>
  final Object input;

  const EmbeddingRequest({
    required this.model,
    required this.input,
  });

  factory EmbeddingRequest.fromJson(Map<String, dynamic> json) =>
      EmbeddingRequest(
        model: json["model"] as String? ?? "",
        input: (json["input"] as Object?) ?? "",
      );

  Map<String, dynamic> toJson() => {
        "model": model,
        "input": input,
      };
}

class EmbeddingData {
  final int index;
  final List<double> embedding;

  const EmbeddingData({
    required this.index,
    required this.embedding,
  });

  factory EmbeddingData.fromJson(Map<String, dynamic> json) => EmbeddingData(
        index: json["index"] as int? ?? 0,
        embedding: (json["embedding"] as List? ?? [])
            .map((e) => (e as num).toDouble())
            .toList(),
      );

  Map<String, dynamic> toJson() => {
        "index": index,
        "embedding": embedding,
      };
}

class EmbeddingResponse {
  final String object; // "list"
  final String model;
  final String provider;
  final List<EmbeddingData> data;
  final Usage? usage;
  final double? costUsd;

  const EmbeddingResponse({
    this.object = "list",
    required this.model,
    required this.provider,
    required this.data,
    this.usage,
    this.costUsd,
  });

  factory EmbeddingResponse.fromJson(Map<String, dynamic> json) {
    final rawData = json["data"] as List? ?? [];
    return EmbeddingResponse(
      object: json["object"] as String? ?? "list",
      model: json["model"] as String? ?? "",
      provider: json["provider"] as String? ?? "",
      data: rawData
          .map((d) => d is Map<String, dynamic> ? EmbeddingData.fromJson(d) : null)
          .whereType<EmbeddingData>()
          .toList(),
      usage: json["usage"] is Map<String, dynamic>
          ? Usage.fromJson(json["usage"] as Map<String, dynamic>)
          : null,
      costUsd: (json["cost_usd"] as num?)?.toDouble(),
    );
  }

  Map<String, dynamic> toJson() => {
        "object": object,
        "model": model,
        "provider": provider,
        "data": data.map((d) => d.toJson()).toList(),
        "usage": usage?.toJson(),
        if (costUsd != null) "cost_usd": costUsd,
      };
}
