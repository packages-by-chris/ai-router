# ai_router

Provider-agnostic AI routing SDK for Dart & Flutter: fallback chains, key pools, rate limiting, and unified streaming across OpenAI, Anthropic, Gemini, Azure, Bedrock, Vertex, and OpenAI-compatible endpoints.

Minimal runtime dependencies — standard Dart HTTP client and crypto.

## Installation

Add to your `pubspec.yaml`:

```yaml
dependencies:
  ai_router: ^0.1.0
```

Or run:

```bash
dart pub add ai_router
```

## Quick Start

```dart
import 'dart:io';
import 'package:ai_router/ai_router.dart';

void main() async {
  // 1. Define configuration with fallback routes & rate limits
  final config = parseConfig({
    'routes': [
      {
        'id': 'fast',
        'provider': 'openai',
        'model': 'gpt-4o-mini',
        'apiKey': '\${OPENAI_API_KEY}',
        'limit': {'rpm': 500},
      },
      {
        'id': 'backup',
        'provider': 'anthropic',
        'model': 'claude-3-5-haiku-20241022',
        'apiKey': '\${ANTHROPIC_API_KEY}',
      },
    ],
  });

  // 2. Initialize router
  final router = AIRouter(config: config);

  // 3. Complete requests with automatic fallback
  final response = await router.complete(
    ChatRequest(
      model: 'fast', // route id
      messages: [
        ChatMessage(role: Roles.user, content: 'Explain quantum computing in one sentence.'),
      ],
    ),
  );

  print(response.choices.first.message.content);

  // 4. Or stream tokens cleanly
  final stream = router.stream(
    ChatRequest(
      model: 'fast',
      messages: [
        ChatMessage(role: Roles.user, content: 'Count from 1 to 5.'),
      ],
    ),
  );

  await for (final chunk in stream) {
    stdout.write(chunk.delta.content ?? '');
  }

  // Or collect stream text:
  // final fullText = await streamText(stream);
}
```

## Features

- **Multi-Provider Unified API**: OpenAI, Anthropic, Gemini, AWS Bedrock (SigV4 signing), Google Vertex AI, Azure OpenAI, and OpenAI-compatible providers (Groq, DeepSeek, Together, Ollama, etc.).
- **Reliable Fallback Chains & Key Pools**: Automatic key rotation on rate limits and failover across model tiers and providers.
- **Rate Limiting & Budgets**: In-memory sliding-window log and rate limit store abstraction.
- **Latency, Cost & Quality Routing**: Strategies like `fallback`, `round-robin`, `weighted`, `least-latency`, `cheapest`, `quality-first`, and `balanced`.
- **Streaming Commit Boundary**: Prevents duplicate tokens when a stream fails mid-response while allowing clean retries before the first byte.
- **Tool Calling & Multimodal**: Complete schema normalization and cross-SDK JSON conformance validation.
- **Strict Typing**: Full strict-mode null safety and zero warnings on `dart analyze`.

## Testing & Conformance

Run unit tests and cross-SDK conformance suites:

```bash
dart test
dart test test/conformance_test.dart
dart analyze
```

## License

MIT
