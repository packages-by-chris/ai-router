import "package:ai_router/ai_router.dart";
import "package:test/test.dart";

void main() {
  group("parseConfig", () {
    test("parses valid config with single route", () {
      final config = parseConfig({
        "routes": [
          {
            "id": "fast",
            "provider": "openai",
            "model": "gpt-4o-mini",
            "apiKey": "sk-test",
          }
        ]
      });

      expect(config.routes.length, equals(1));
      expect(config.routes[0].id, equals("fast"));
      expect(config.routes[0].provider, equals("openai"));
      expect(config.routes[0].model, equals("gpt-4o-mini"));
      expect(config.routes[0].apiKey, equals("sk-test"));
    });

    test("interpolates \${ENV_VAR} patterns", () {
      final config = parseConfig(
        {
          "routes": [
            {
              "id": "primary",
              "provider": "anthropic",
              "model": "claude-3-5-sonnet-20241022",
              "apiKey": "\${ANTHROPIC_KEY}",
            }
          ]
        },
        {"ANTHROPIC_KEY": "sk-ant-12345"},
      );

      expect(config.routes[0].apiKey, equals("sk-ant-12345"));
    });

    test("throws ConfigError when env var is missing", () {
      expect(
        () => parseConfig(
          {
            "routes": [
              {
                "id": "primary",
                "provider": "openai",
                "model": "gpt-4o",
                "apiKey": "\${MISSING_KEY}",
              }
            ]
          },
          {},
        ),
        throwsA(isA<ConfigError>().having(
          (e) => e.message,
          "message",
          contains('environment variable "MISSING_KEY" is not set'),
        )),
      );
    });

    test("aggregates multiple errors", () {
      expect(
        () => parseConfig({
          "unknownField": 123,
          "routes": [
            {
              "id": "r1",
              "provider": "invalid-provider",
              "model": "",
            }
          ]
        }),
        throwsA(isA<ConfigError>().having(
          (e) => e.message,
          "message",
          allOf([
            contains("unknown field"),
            contains("unknown provider"),
          ]),
        )),
      );
    });

    test("validates strategy and weights", () {
      final config = parseConfig({
        "strategy": "balanced",
        "weights": {
          "cost": 0.6,
          "speed": 0.3,
          "reliability": 0.1,
        },
        "routes": [
          {
            "id": "fast",
            "provider": "openai",
            "model": "gpt-4o-mini",
            "apiKey": "sk-test",
          }
        ]
      });

      expect(config.strategy, equals("balanced"));
      expect(config.weights?.cost, equals(0.6));
      expect(config.weights?.speed, equals(0.3));
      expect(config.weights?.reliability, equals(0.1));
    });
  });
}
