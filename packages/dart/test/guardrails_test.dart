import "package:ai_router/ai_router.dart";
import "package:test/test.dart";

class MockKeywordInputGuardrail extends InputGuardrail {
  final String forbidden;
  MockKeywordInputGuardrail(this.forbidden);

  @override
  String get name => "keyword_filter";

  @override
  GuardrailVerdict check(ChatRequest req) {
    for (final msg in req.messages) {
      if (msg.content is String && (msg.content as String).contains(forbidden)) {
        return GuardrailVerdict(pass: false, reason: "Contains forbidden keyword '$forbidden'");
      }
    }
    return const GuardrailVerdict(pass: true);
  }
}

class MockRedactOutputGuardrail extends OutputGuardrail {
  @override
  String get name => "redactor";

  @override
  GuardrailVerdict check(ChatResponse res) {
    final choices = res.choices.map((c) {
      final text = c.message.content is String ? (c.message.content as String).replaceAll("SECRET", "[REDACTED]") : c.message.content;
      return Choice(
        index: c.index,
        finishReason: c.finishReason,
        message: ChatMessage(
          role: c.message.role,
          content: text,
        ),
      );
    }).toList();

    return GuardrailVerdict(
      pass: true,
      replace: res.copyWith(choices: choices),
    );
  }
}

void main() {
  group("Guardrails", () {
    test("input guardrail blocks request with GuardrailBlockedError", () async {
      final guard = MockKeywordInputGuardrail("BAD_WORD");
      const req = ChatRequest(
        model: "fast",
        messages: [
          ChatMessage(role: Roles.user, content: "Hello BAD_WORD world"),
        ],
      );

      expect(
        () => runInputGuardrails([guard], req),
        throwsA(isA<GuardrailBlockedError>().having(
          (e) => e.message,
          "message",
          contains("guardrail \"keyword_filter\" blocked input: Contains forbidden keyword 'BAD_WORD'"),
        )),
      );
    });

    test("output guardrail can rewrite response payload", () async {
      final guard = MockRedactOutputGuardrail();
      const res = ChatResponse(
        id: "1",
        model: "m",
        provider: "p",
        created: 0,
        choices: [
          Choice(
            index: 0,
            message: ChatMessage(role: Roles.assistant, content: "My SECRET key is 123"),
          ),
        ],
      );

      final modified = await runOutputGuardrails([guard], res);
      expect(modified.choices[0].message.content, equals("My [REDACTED] key is 123"));
    });
  });
}
