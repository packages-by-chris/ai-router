import "openai.dart";
import "types.dart";

const String azureDefaultApiVersion = "2024-10-21";
const List<String> azureOptionNamespaces = ["openai", "azure"];

class _AzureConfig {
  final String base;
  final String apiVersion;
  const _AzureConfig(this.base, this.apiVersion);
}

_AzureConfig _requireAzure(NormalizedRoute route) {
  if (route.baseUrl == null || route.baseUrl!.isEmpty) {
    throw Exception('route "${route.id}": azure provider requires baseUrl');
  }
  return _AzureConfig(
    route.baseUrl!.replaceAll(RegExp(r"/+$"), ""),
    route.apiVersion ?? azureDefaultApiVersion,
  );
}

String _deploymentUrl(NormalizedRoute route, String action) {
  final cfg = _requireAzure(route);
  final encodedModel = Uri.encodeComponent(route.model);
  final encodedVersion = Uri.encodeComponent(cfg.apiVersion);
  return "${cfg.base}/openai/deployments/$encodedModel/$action?api-version=$encodedVersion";
}

class AzureAdapter extends OpenAIAdapter {
  @override
  String get id => "azure";

  @override
  String labelFor(NormalizedRoute route) => "azure";

  @override
  String base(NormalizedRoute route) => "";

  @override
  String chatEndpoint(NormalizedRoute route) => _deploymentUrl(route, "chat/completions");

  @override
  String embedEndpoint(NormalizedRoute route) => _deploymentUrl(route, "embeddings");

  @override
  String rawEndpoint(NormalizedRoute route, RawRequestOptions opts) {
    if (opts.path != null) {
      final cfg = _requireAzure(route);
      final sep = opts.path!.contains("?") ? "&" : "?";
      final encodedVersion = Uri.encodeComponent(cfg.apiVersion);
      return "${cfg.base}${opts.path}$sep" "api-version=$encodedVersion";
    }
    return _deploymentUrl(route, "chat/completions");
  }

  @override
  Map<String, String> authHeaders(NormalizedRoute route, String key) => {"api-key": key};

  @override
  List<String> optionNamespaces() => azureOptionNamespaces;
}
