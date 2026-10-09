import "dart:async";
import "errors.dart";
import "types.dart";

class GuardrailVerdict {
  final bool pass;
  final String? reason;
  final Object? replace;

  const GuardrailVerdict({
    this.pass = true,
    this.reason,
    this.replace,
  });
}

abstract class InputGuardrail {
  String? get name => null;
  FutureOr<GuardrailVerdict> check(ChatRequest req);
}

abstract class OutputGuardrail {
  String? get name => null;
  FutureOr<GuardrailVerdict> check(ChatResponse res);
}

class Guardrails {
  final List<InputGuardrail>? input;
  final List<OutputGuardrail>? output;

  const Guardrails({this.input, this.output});
}

class GuardrailBlockedError extends AIRouterError {
  final String phase; // "input" | "output"
  final String guardrail;
  final String? reason;

  GuardrailBlockedError(this.phase, this.guardrail, [this.reason])
      : super('guardrail "$guardrail" blocked $phase${reason != null ? ": $reason" : ""}');
}

Future<ChatRequest> runInputGuardrails(
  List<InputGuardrail>? guards,
  ChatRequest req,
) async {
  if (guards == null || guards.isEmpty) return req;
  var current = req;
  for (int i = 0; i < guards.length; i++) {
    final guard = guards[i];
    final verdict = await guard.check(current);
    if (!verdict.pass) {
      throw GuardrailBlockedError("input", guard.name ?? "guardrails[$i]", verdict.reason);
    }
    if (verdict.replace is ChatRequest) {
      current = verdict.replace as ChatRequest;
    }
  }
  return current;
}

Future<ChatResponse> runOutputGuardrails(
  List<OutputGuardrail>? guards,
  ChatResponse res,
) async {
  if (guards == null || guards.isEmpty) return res;
  var current = res;
  for (int i = 0; i < guards.length; i++) {
    final guard = guards[i];
    final verdict = await guard.check(current);
    if (!verdict.pass) {
      throw GuardrailBlockedError("output", guard.name ?? "guardrails[$i]", verdict.reason);
    }
    if (verdict.replace is ChatResponse) {
      current = verdict.replace as ChatResponse;
    }
  }
  return current;
}
