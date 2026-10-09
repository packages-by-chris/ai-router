# ai_router

**Embeddable, provider-agnostic AI routing engine for Dart & Flutter.**

`ai_router` brings the routing, reliability, and governance capabilities of an AI gateway directly into your Dart and Flutter applications. It runs in-process, talks to LLM providers directly over their native APIs, and handles:

- **Ordered fallback chains** across models, tiers, and providers.
- **Smart routing strategies**: `fallback`, `round-robin`, `weighted`, `least-latency`, `cheapest`, `balanced`, `quality-first`.
- **In-memory sliding-window rate limiting** (RPM / TPM) & **spend budget caps** (USD).
- **Statistical health tracking** (Wilson lower-bound scoring, latency EMA, adaptive error backoff).
- **Key-pool rotation & circuit breaking**.
- **Real-time streaming via standard Dart Streams** (`Stream<ChatChunk>`) with commit-boundary guarantees.
- **Pluggable Input / Output Guardrails** to block or rewrite prompts and completions.
- **Minimal runtime dependencies** — built with standard Dart `http` and `crypto` libraries.

---

## Installation

Add `ai_router` to your `pubspec.yaml`:

```yaml
dependencies:
  ai_router: ^0.1.0
```

Or install with `dart pub`:

```bash
dart pub add ai_router
```

---

## Quick Start

### 1. Unified Completions with Automatic Fallback

```dart
import 'package:ai_router/ai_router.dart';

void main() async {
  // 1. Define configuration with declarative fallback routes & rate limits
  final router = AIRouter(
    config: parseConfig({
      'strategy': 'fallback',
      'routes': [
        {
          'id': 'fast',
          'provider': 'openai',
          'model': 'gpt-4o-mini',
          'apiKey': '${OPENAI_API_KEY}',
          'limit': {'rpm': 500},
        },
        {
          'id': 'backup-anthropic',
          'provider': 'anthropic',
          'model': 'claude-3-5-haiku-20241022',
          'apiKey': '${ANTHROPIC_API_KEY}',
        },
        {
          'id': 'backup-gemini',
          'provider': 'gemini',
          'model': 'gemini-2.0-flash',
          'apiKey': '${GEMINI_API_KEY}',
        },
      ],
    }),
  );

  // 2. Complete request — model is a route id, not a provider model name
  final response = await router.complete(
    const ChatRequest(
      model: 'fast',
      messages: [
        ChatMessage(role: Roles.user, content: 'Explain distributed consensus in two sentences.'),
      ],
    ),
  );

  print(response.choices.first.message.content);
  print('Served by: ${response.provider} (${response.model})');
}
```

---

### 2. Real-Time Streaming with Dart Streams

Streaming returns a standard `Stream<ChatChunk>` with a **committed stream contract**: attempt events and retries occur before the first token, ensuring zero duplicate tokens once streaming begins.

```dart
import 'dart:io';
import 'package:ai_router/ai_router.dart';

void main() async {
  final router = AIRouter(
    config: parseConfig({
      'routes': [
        {'id': 'fast', 'provider': 'openai', 'model': 'gpt-4o-mini', 'apiKey': '${OPENAI_API_KEY}'},
      ],
    }),
  );

  final stream = router.stream(
    const ChatRequest(
      model: 'fast',
      messages: [
        ChatMessage(role: Roles.user, content: 'Count from 1 to 10 with a brief note for each.'),
      ],
    ),
  );

  await for (final chunk in stream) {
    if (chunk.delta.content != null) {
      stdout.write(chunk.delta.content);
    }
  }

  // Or collect stream text into a single String:
  // final fullText = await streamText(stream);
}
```

---

### 3. Tool Calling

Tool schemas and invocations are normalized across OpenAI, Anthropic, Gemini, AWS Bedrock, and Azure:

```dart
final response = await router.complete(
  ChatRequest(
    model: 'fast',
    messages: const [ChatMessage(role: Roles.user, content: 'What is the weather in Tokyo?')],
    tools: [
      Tool(
        type: 'function',
        function: FunctionDef(
          name: 'get_weather',
          description: 'Get current weather for a city',
          parameters: {
            'type': 'object',
            'properties': {
              'location': {'type': 'string'},
            },
            'required': ['location'],
          },
        ),
      ),
    ],
  ),
);

for (final call in response.choices.first.message.toolCalls) {
  print('Function: ${call.function?.name}, Args: ${call.function?.arguments}');
}
```

---

### 4. Input & Output Guardrails

```dart
final redactKeys = InputGuardrail(
  name: 'redact-keys',
  check: (req) async {
    final messages = req.messages.map((m) {
      if (m.content is String && (m.content as String).contains('sk-')) {
        return ChatMessage(
          role: m.role,
          content: (m.content as String).replaceAll(RegExp(r'sk-[a-zA-Z0-9]{20,}'), '[REDACTED]'),
        );
      }
      return m;
    }).toList();

    return GuardrailVerdict(
      pass: true,
      replace: req.copyWith(messages: messages),
    );
  },
);

final router = AIRouter(
  config: config,
  options: AIRouterOptions(
    guardrails: GuardrailOptions(input: [redactKeys]),
  ),
);
```

---

## Supported Providers

| Provider | ID | Authentication / Wire Protocol |
|---|---|---|
| **OpenAI** | `openai` | Bearer token (`apiKey` / `apiKeys`) |
| **Anthropic** | `anthropic` | `x-api-key` + `anthropic-version` |
| **Google Gemini** | `gemini` | `x-goog-api-key` REST API |
| **AWS Bedrock** | `bedrock` | AWS SigV4 signed requests (`Converse` API) |
| **Azure OpenAI** | `azure` | `api-key` header with deployment route layout |
| **Google Vertex AI** | `vertex` | Bearer OAuth token + GCP Project/Region layout |
| **OpenAI-Compatible** | `openai-compatible` | DeepSeek, Groq, Together, Ollama, vLLM, etc. |

---

## Testing & Conformance

Run the full unit test and cross-SDK JSON conformance suite:

```bash
dart test
dart test test/conformance_test.dart
dart analyze
```

---

## License

[MIT](../../LICENSE)
