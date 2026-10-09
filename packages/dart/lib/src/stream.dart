import "types.dart";

/// Extract text deltas from a stream of ChatChunk objects.
Stream<String> streamText(Stream<ChatChunk> stream) async* {
  await for (final chunk in stream) {
    if (chunk.delta.content != null && chunk.delta.content!.isNotEmpty) {
      yield chunk.delta.content!;
    }
  }
}

/// Collect a stream of chunks into a single aggregated ChatResponse.
Future<ChatResponse> collectStream(Stream<ChatChunk> stream) async {
  String id = "";
  String model = "";
  String provider = "";
  String content = "";
  String reasoning = "";
  String? finishReason;
  Usage? usage;
  double? costUsd;

  final toolCallsMap = <int, ({String id, String name, StringBuffer args})>{};

  await for (final chunk in stream) {
    if (id.isEmpty && chunk.id.isNotEmpty) id = chunk.id;
    if (model.isEmpty && chunk.model.isNotEmpty) model = chunk.model;
    if (provider.isEmpty && chunk.provider.isNotEmpty) provider = chunk.provider;
    if (chunk.delta.content != null) content += chunk.delta.content!;
    if (chunk.delta.reasoning != null) reasoning += chunk.delta.reasoning!;
    if (chunk.finishReason != null) finishReason = chunk.finishReason;
    if (chunk.usage != null) usage = chunk.usage;
    if (chunk.costUsd != null) costUsd = chunk.costUsd;

    if (chunk.delta.toolCalls != null) {
      for (final tc in chunk.delta.toolCalls!) {
        final existing = toolCallsMap[tc.index];
        final curId = tc.id ?? existing?.id ?? "";
        final curName = tc.function?.name ?? existing?.name ?? "";
        final argsBuf = existing?.args ?? StringBuffer();
        if (tc.function?.arguments != null) {
          argsBuf.write(tc.function!.arguments);
        }
        toolCallsMap[tc.index] = (id: curId, name: curName, args: argsBuf);
      }
    }
  }

  List<ToolCall>? toolCalls;
  if (toolCallsMap.isNotEmpty) {
    final sortedKeys = toolCallsMap.keys.toList()..sort();
    toolCalls = sortedKeys.map((idx) {
      final item = toolCallsMap[idx]!;
      return ToolCall(
        id: item.id,
        type: "function",
        function: ToolCallFunction(
          name: item.name,
          arguments: item.args.toString(),
        ),
      );
    }).toList();
  }

  return ChatResponse(
    id: id,
    model: model,
    provider: provider,
    created: DateTime.now().millisecondsSinceEpoch ~/ 1000,
    usage: usage,
    costUsd: costUsd,
    choices: [
      Choice(
        index: 0,
        finishReason: finishReason,
        message: ChatMessage(
          role: Roles.assistant,
          content: content.isNotEmpty ? content : toolCalls != null ? null : "",
          reasoning: reasoning.isNotEmpty ? reasoning : null,
          toolCalls: toolCalls,
        ),
      ),
    ],
  );
}
