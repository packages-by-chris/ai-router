import "../errors.dart";
import "anthropic.dart";
import "azure.dart";
import "bedrock.dart";
import "gemini.dart";
import "openai.dart";
import "presets.dart";
import "types.dart";
import "vertex.dart";

final _openai = OpenAIAdapter();
final _azure = AzureAdapter();
final _anthropic = AnthropicAdapter();
final _gemini = GeminiAdapter();
final _bedrock = BedrockAdapter();
final _vertex = VertexAdapter();

final Map<String, ProviderAdapter> _builtinAdapters = {
  "openai": _openai,
  "azure": _azure,
  "anthropic": _anthropic,
  "gemini": _gemini,
  "bedrock": _bedrock,
  "vertex": _vertex,
};

final Map<String, ProviderAdapter> _customAdapters = {};

/// Register a third-party adapter under a provider id.
void registerAdapter(String id, ProviderAdapter Function() create) {
  if (_builtinAdapters.containsKey(id)) {
    throw Exception('registerAdapter: "$id" collides with a built-in provider');
  }
  if (!RegExp(r"^[a-zA-Z][a-zA-Z0-9_-]*$").hasMatch(id)) {
    throw Exception('registerAdapter: "$id" must match [a-zA-Z][a-zA-Z0-9_-]*');
  }
  _customAdapters[id] = create();
}

List<String> knownProviderIds() {
  return [
    ..._builtinAdapters.keys,
    "openai-compatible",
    ...providerPresets.keys,
    ..._customAdapters.keys,
  ];
}

ProviderAdapter getAdapter(String providerId) {
  final builtin = _builtinAdapters[providerId] ??
      (providerId == "openai-compatible" ? _openai : null);
  if (builtin != null) return builtin;
  final custom = _customAdapters[providerId];
  if (custom != null) return custom;
  throw UnsupportedProviderError(
    'provider "$providerId" is not implemented${providerPresets.containsKey(providerId) ? "" : " (known: ${knownProviderIds().join(", ")})"}'
  );
}

bool isSupported(String providerId) {
  return _builtinAdapters.containsKey(providerId) ||
      providerId == "openai-compatible" ||
      _customAdapters.containsKey(providerId);
}
