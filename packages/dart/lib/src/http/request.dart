import "dart:async";
import "dart:convert";
import "package:http/http.dart" as http;
import "../errors.dart";

/// Read Retry-After (seconds or HTTP-date) as milliseconds.
int? parseRetryAfter(Map<String, String> headers) {
  final raw = headers["retry-after"] ?? headers["Retry-After"];
  if (raw == null || raw.trim().isEmpty) return null;
  final clean = raw.trim();
  final seconds = int.tryParse(clean);
  if (seconds != null) return seconds > 0 ? seconds * 1000 : 0;
  final date = DateTime.tryParse(clean);
  if (date != null) {
    final diff = date.millisecondsSinceEpoch - DateTime.now().millisecondsSinceEpoch;
    return diff > 0 ? diff : 0;
  }
  return null;
}

String errorMessage(Object? err) {
  if (err is AIRouterError) return err.message;
  if (err is Exception) return err.toString();
  return "$err";
}

/// Shared non-2xx handling. OpenAI and Anthropic error bodies both carry
/// { error: { message } }, so one implementation serves every adapter.
Future<void> requireOk(http.Response resp, String provider) async {
  if (resp.statusCode >= 200 && resp.statusCode < 300) return;
  final kind = classifyStatus(resp.statusCode);
  Object? body;
  String message = "$provider: HTTP ${resp.statusCode}";
  final text = resp.body;
  if (text.isNotEmpty) {
    try {
      body = jsonDecode(text);
      if (body is Map) {
        final errObj = body["error"];
        if (errObj is Map && errObj["message"] != null) {
          message = "$provider: ${errObj["message"]}";
        } else if (body["message"] != null) {
          message = "$provider: ${body["message"]}";
        }
      }
    } catch (_) {
      // non-JSON error body; keep the generic message
    }
  }
  throw ProviderError(
    provider,
    kind,
    message,
    status: resp.statusCode,
    retryAfterMs: parseRetryAfter(resp.headers),
    body: body,
  );
}

/// Wrap a low-level failure into a retryable ProviderError.
ProviderError toNetworkError(String provider, Object? err) {
  if (err is ProviderError) return err;
  final isTimeout = err is TimeoutException ||
      (err is Exception && err.toString().toLowerCase().contains("timeout"));
  return ProviderError(
    provider,
    isTimeout ? ErrorKinds.timeout : ErrorKinds.network,
    errorMessage(err),
    cause: err,
  );
}
