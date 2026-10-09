/// Capability-aware routing metadata.
///
/// Routes may declare what their model supports (`capabilities` in config).
/// Requirements reach the router two ways, with different failure semantics:
///
///   1. Explicit requirements (`routing.require`) are HARD constraints: a
///      candidate must declare the capability true, otherwise it is
///      eliminated — including candidates with NO declared profile (an
///      explicit demand is not satisfied by an unknown).
///   2. Request-inferred requirements (request carries tools -> needs tools,
///      image parts -> vision, json_schema -> structuredOutput,
///      reasoning_effort -> reasoning, stream()/embed() -> their flags) are
///      METADATA-DRIVEN: only candidates that DECLARE a conflicting profile
///      are eliminated. Undeclared routes stay eligible so existing configs
///      never change behavior.
///
/// `contextWindow`, when declared, eliminates candidates whose estimated
/// input tokens exceed it.

import "../types.dart";

/// Declared per-route capability profile.
class ModelCapabilities {
  final bool? streaming;
  final bool? tools;
  final bool? vision;
  final bool? json;
  final bool? structuredOutput;
  final bool? reasoning;
  final bool? audio;
  final bool? embeddings;
  final bool? multimodal;
  final bool? longContext;
  final int? contextWindow;

  const ModelCapabilities({
    this.streaming,
    this.tools,
    this.vision,
    this.json,
    this.structuredOutput,
    this.reasoning,
    this.audio,
    this.embeddings,
    this.multimodal,
    this.longContext,
    this.contextWindow,
  });

  factory ModelCapabilities.fromJson(Map<String, dynamic> json) =>
      ModelCapabilities(
        streaming: json["streaming"] as bool?,
        tools: json["tools"] as bool?,
        vision: json["vision"] as bool?,
        json: json["json"] as bool?,
        structuredOutput: json["structuredOutput"] as bool?,
        reasoning: json["reasoning"] as bool?,
        audio: json["audio"] as bool?,
        embeddings: json["embeddings"] as bool?,
        multimodal: json["multimodal"] as bool?,
        longContext: json["longContext"] as bool?,
        contextWindow: json["contextWindow"] as int?,
      );

  Map<String, dynamic> toJson() => {
        if (streaming != null) "streaming": streaming,
        if (tools != null) "tools": tools,
        if (vision != null) "vision": vision,
        if (json != null) "json": json,
        if (structuredOutput != null) "structuredOutput": structuredOutput,
        if (reasoning != null) "reasoning": reasoning,
        if (audio != null) "audio": audio,
        if (embeddings != null) "embeddings": embeddings,
        if (multimodal != null) "multimodal": multimodal,
        if (longContext != null) "longContext": longContext,
        if (contextWindow != null) "contextWindow": contextWindow,
      };

  bool? getByKey(String key) {
    switch (key) {
      case "streaming":
        return streaming;
      case "tools":
        return tools;
      case "vision":
        return vision;
      case "json":
        return json;
      case "structuredOutput":
        return structuredOutput;
      case "reasoning":
        return reasoning;
      case "audio":
        return audio;
      case "embeddings":
        return embeddings;
      case "multimodal":
        return multimodal;
      case "longContext":
        return longContext;
      default:
        return null;
    }
  }
}

/// Explicit per-call requirements (`routing.require`). true = must support.
typedef CapabilityRequirement = Map<String, bool>;

/// Which engine operation a candidate is being evaluated for.
typedef RouteOp = String;

class RouteOps {
  static const String complete = "complete";
  static const String stream = "stream";
  static const String embed = "embed";
}

const List<String> booleanCaps = [
  "streaming",
  "tools",
  "vision",
  "json",
  "structuredOutput",
  "reasoning",
  "audio",
  "embeddings",
  "multimodal",
  "longContext",
];

/// Requirements implied by the logical request itself.
CapabilityRequirement inferredRequirements(ChatRequest req, RouteOp op) {
  final need = <String, bool>{};
  if (op == RouteOps.stream) need["streaming"] = true;
  if (op == RouteOps.embed) need["embeddings"] = true;
  if (req.tools != null && req.tools!.isNotEmpty) need["tools"] = true;
  for (final msg in req.messages) {
    if (msg.content is List) {
      final list = msg.content as List;
      if (list.any((p) => (p is ContentPart && p.type == "image_url") || (p is Map && p["type"] == "image_url"))) {
        need["vision"] = true;
        break;
      }
    }
  }
  if (req.responseFormat is JsonObjectResponseFormat ||
      (req.responseFormat != null && req.responseFormat!.type == "json_object")) {
    need["json"] = true;
  }
  if (req.responseFormat is JsonSchemaResponseFormat ||
      (req.responseFormat != null && req.responseFormat!.type == "json_schema")) {
    need["structuredOutput"] = true;
  }
  if (req.reasoningEffort != null) need["reasoning"] = true;
  return need;
}

/// Rejection reason when a candidate cannot serve this request, or null when
/// eligible. See the module docs for hard-vs-metadata semantics.
///
/// `estimatedInputTokens` gates `contextWindow` when declared.
String? capabilityRejection(
  ModelCapabilities? caps,
  ChatRequest req,
  RouteOp op,
  CapabilityRequirement? require, [
  int? estimatedInputTokens,
]) {
  final inferred = inferredRequirements(req, op);

  // Hard constraints first: explicit demands beat declarations' absence.
  if (require != null) {
    for (final key in booleanCaps) {
      if (require[key] == true && caps?.getByKey(key) != true) {
        return "requires $key but route does not declare it";
      }
    }
  }

  // Metadata-driven inference: only declared profiles can conflict.
  if (caps != null) {
    for (final key in booleanCaps) {
      if (inferred[key] == true && caps.getByKey(key) != true) {
        return "request needs $key but route does not declare it";
      }
    }
    if (caps.contextWindow != null &&
        estimatedInputTokens != null &&
        estimatedInputTokens > caps.contextWindow!) {
      return "estimated $estimatedInputTokens input tokens exceeds contextWindow ${caps.contextWindow}";
    }
  }

  return null;
}
