package airouter_test

import (
	"strings"
	"testing"

	airouter "github.com/ai-router-sdk/ai-router-go"
)

func TestParseConfig(t *testing.T) {
	t.Run("parses valid config with single route", func(t *testing.T) {
		input := map[string]any{
			"routes": []any{
				map[string]any{
					"id":       "fast",
					"provider": "openai",
					"model":    "gpt-4o-mini",
					"apiKey":   "sk-test-key",
				},
			},
		}

		cfg, err := airouter.ParseConfig(input)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(cfg.Routes) != 1 {
			t.Fatalf("expected 1 route, got %d", len(cfg.Routes))
		}
		if cfg.Routes[0].ID != "fast" || cfg.Routes[0].Model != "gpt-4o-mini" {
			t.Errorf("route fields mismatch: %+v", cfg.Routes[0])
		}
		if cfg.Strategy != airouter.StrategyFallback {
			t.Errorf("expected default strategy fallback, got %s", cfg.Strategy)
		}
	})

	t.Run("interpolates ${ENV_VAR} patterns", func(t *testing.T) {
		input := map[string]any{
			"routes": []any{
				map[string]any{
					"id":       "fast",
					"provider": "openai",
					"model":    "gpt-4o-mini",
					"apiKey":   "${MY_TEST_KEY}",
				},
			},
		}
		env := map[string]string{
			"MY_TEST_KEY": "secret-12345",
		}

		cfg, err := airouter.ParseConfig(input, env)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if cfg.Routes[0].APIKey != "secret-12345" {
			t.Errorf("expected interpolated apiKey 'secret-12345', got %q", cfg.Routes[0].APIKey)
		}
	})

	t.Run("throws ConfigError when env var is missing", func(t *testing.T) {
		input := map[string]any{
			"routes": []any{
				map[string]any{
					"id":       "fast",
					"provider": "openai",
					"model":    "gpt-4o-mini",
					"apiKey":   "${UNSET_VAR}",
				},
			},
		}

		_, err := airouter.ParseConfig(input, map[string]string{})
		if err == nil {
			t.Fatal("expected error, got nil")
		}
		if !strings.Contains(err.Error(), "UNSET_VAR") {
			t.Errorf("expected error mentioning UNSET_VAR, got %v", err)
		}
	})

	t.Run("aggregates multiple validation errors", func(t *testing.T) {
		input := map[string]any{
			"strategy": "invalid-strategy",
			"routes": []any{
				map[string]any{
					"id":       "",
					"provider": "",
					"model":    "",
				},
			},
		}

		_, err := airouter.ParseConfig(input)
		if err == nil {
			t.Fatal("expected error, got nil")
		}
		errStr := err.Error()
		if !strings.Contains(errStr, "strategy") {
			t.Errorf("expected strategy error in %s", errStr)
		}
	})
}
