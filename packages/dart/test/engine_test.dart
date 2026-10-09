import "dart:async";
import "package:ai_router/ai_router.dart";
import "package:http/http.dart" as http;
import "package:test/test.dart";

class FakeAdapter implements ProviderAdapter {
  final String _id;
  final Future<ChatResponse> Function(NormalizedRoute route, String key, ChatRequest req) _onComplete;
  final Future<Stream<ChatChunk>> Function(NormalizedRoute route, String key, ChatRequest req)? _onStream;

  FakeAdapter(this._id, this._onComplete, [this._onStream]);

  @override
  String get id => _id;

  @override
  Future<ChatResponse> complete(
    NormalizedRoute route,
    String key,
    ChatRequest req,
    AdapterContext ctx,
  ) =>
      _onComplete(route, key, req);

  @override
  Future<Stream<ChatChunk>> stream(
    NormalizedRoute route,
    String key,
    ChatRequest req,
    AdapterContext ctx,
  ) {
    if (_onStream != null) return _onStream!(route, key, req);
    throw UnimplementedError();
  }

  @override
  Future<http.Response> raw(
    NormalizedRoute route,
    String key,
    RawRequestOptions opts,
    AdapterContext ctx,
  ) async =>
      http.Response("{}", 200);

  @override
  Future<EmbeddingResponse> embed(
    NormalizedRoute route,
    String key,
    EmbeddingRequest req,
    AdapterContext ctx,
  ) async =>
      throw UnimplementedError();
}

void main() {
  group("RoutingEngine & AIRouter", () {
    test("falls back to secondary route when primary fails with non-retryable error", () async {
      int primaryCalls = 0;
      int secondaryCalls = 0;

      final adapter1 = FakeAdapter("openai", (route, key, req) async {
        primaryCalls++;
        throw ProviderError("openai", ErrorKinds.invalidRequest, "model not found", status: 400);
      });

      final adapter2 = FakeAdapter("anthropic", (route, key, req) async {
        secondaryCalls++;
        return const ChatResponse(
          id: "resp_secondary",
          model: "claude-3-5-sonnet-20241022",
          provider: "anthropic",
          created: 0,
          choices: [
            Choice(
              index: 0,
              message: ChatMessage(role: Roles.assistant, content: "Hello from Anthropic!"),
            ),
          ],
        );
      });

      registerAdapter("fake-openai", () => adapter1);
      registerAdapter("fake-anthropic", () => adapter2);

      final router = AIRouter(
        {
          "routes": [
            {
              "id": "fast",
              "provider": "fake-openai",
              "model": "gpt-4o",
              "apiKey": "k1",
            },
            {
              "id": "backup",
              "provider": "fake-anthropic",
              "model": "claude-3-5-sonnet",
              "apiKey": "k2",
            },
          ]
        },
        options: const EngineOptions(
          sleep: _noSleep,
        ),
      );

      final res = await router.complete(const ChatRequest(
        model: "fast",
        messages: [ChatMessage(role: Roles.user, content: "Hi")],
      ));

      expect(primaryCalls, equals(1));
      expect(secondaryCalls, equals(1));
      expect(res.provider, equals("anthropic"));
      expect(res.choices[0].message.content, equals("Hello from Anthropic!"));
    });

    test("retries same route and rotates key on rate_limit", () async {
      final keysUsed = <String>[];

      final adapter = FakeAdapter("fake-key-rotator", (route, key, req) async {
        keysUsed.add(key);
        if (keysUsed.length < 2) {
          throw ProviderError("fake-key-rotator", ErrorKinds.rateLimit, "Rate limited", status: 429);
        }
        return const ChatResponse(
          id: "resp_success",
          model: "m",
          provider: "fake-key-rotator",
          created: 0,
          choices: [
            Choice(
              index: 0,
              message: ChatMessage(role: Roles.assistant, content: "Success on key rotation!"),
            ),
          ],
        );
      });

      registerAdapter("fake-key-rotator", () => adapter);

      final router = AIRouter(
        {
          "routes": [
            {
              "id": "pool-route",
              "provider": "fake-key-rotator",
              "model": "m",
              "apiKeys": ["key_A", "key_B"],
            }
          ]
        },
        options: const EngineOptions(sleep: _noSleep),
      );

      final res = await router.complete(const ChatRequest(
        model: "pool-route",
        messages: [ChatMessage(role: Roles.user, content: "Hi")],
      ));

      expect(keysUsed, equals(["key_A", "key_B"]));
      expect(res.choices[0].message.content, equals("Success on key rotation!"));
    });

    test("streaming commit boundary: falls back if first stream fails before first token", () async {
      final streamAdapter1 = FakeAdapter("fake-stream-1", (route, key, req) async => throw UnimplementedError(),
          (route, key, req) async {
        // Yields empty stream immediately -> triggers network error pre-commit
        return Stream.fromIterable(<ChatChunk>[]);
      });

      final streamAdapter2 = FakeAdapter("fake-stream-2", (route, key, req) async => throw UnimplementedError(),
          (route, key, req) async {
        return Stream.fromIterable([
          const ChatChunk(
            id: "c1",
            model: "m2",
            provider: "fake-stream-2",
            delta: Delta(role: Roles.assistant, content: "Hello "),
          ),
          const ChatChunk(
            id: "c1",
            model: "m2",
            provider: "fake-stream-2",
            delta: Delta(content: "World!"),
          ),
        ]);
      });

      registerAdapter("fake-stream-1", () => streamAdapter1);
      registerAdapter("fake-stream-2", () => streamAdapter2);

      final router = AIRouter(
        {
          "routes": [
            {
              "id": "stream-route",
              "provider": "fake-stream-1",
              "model": "m1",
              "apiKey": "k1",
            },
            {
              "id": "stream-backup",
              "provider": "fake-stream-2",
              "model": "m2",
              "apiKey": "k2",
            },
          ]
        },
        options: const EngineOptions(sleep: _noSleep),
      );

      final stream = await router.stream(const ChatRequest(
        model: "stream-route",
        messages: [ChatMessage(role: Roles.user, content: "Hi")],
      ));

      final fullResponse = await collectStream(stream);
      expect(fullResponse.provider, equals("fake-stream-2"));
      expect(fullResponse.choices[0].message.content, equals("Hello World!"));
    });
  });
}

Future<void> _noSleep(int ms) async {}
