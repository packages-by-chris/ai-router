package airouter_test

import (
	"context"
	"strings"
	"testing"

	airouter "github.com/ai-router-sdk/ai-router-go"
)

type mockKeywordInputGuardrail struct {
	blockedKeyword string
}

func (g *mockKeywordInputGuardrail) Name() string {
	return "mock-keyword-guard"
}

func (g *mockKeywordInputGuardrail) Evaluate(ctx context.Context, req *airouter.ChatRequest) (airouter.GuardrailVerdict, error) {
	for _, m := range req.Messages {
		if s, ok := m.Content.(string); ok && strings.Contains(s, g.blockedKeyword) {
			return airouter.GuardrailVerdict{
				Action: "block",
				Reason: "Contains blocked keyword: " + g.blockedKeyword,
			}, nil
		}
	}
	return airouter.GuardrailVerdict{Action: "pass"}, nil
}

type mockScrubOutputGuardrail struct {
	targetWord string
}

func (g *mockScrubOutputGuardrail) Name() string {
	return "mock-scrub-guard"
}

func (g *mockScrubOutputGuardrail) Evaluate(ctx context.Context, req *airouter.ChatRequest, resp *airouter.ChatResponse) (airouter.GuardrailVerdict, error) {
	if len(resp.Choices) > 0 {
		if s, ok := resp.Choices[0].Message.Content.(string); ok && strings.Contains(s, g.targetWord) {
			replaced := strings.ReplaceAll(s, g.targetWord, "[REDACTED]")
			newChoices := make([]airouter.Choice, len(resp.Choices))
			copy(newChoices, resp.Choices)
			newChoices[0].Message.Content = replaced
			rewritten := *resp
			rewritten.Choices = newChoices
			return airouter.GuardrailVerdict{
				Action:        "rewrite",
				RewrittenBody: &rewritten,
			}, nil
		}
	}
	return airouter.GuardrailVerdict{Action: "pass"}, nil
}

func TestGuardrails(t *testing.T) {
	ctx := context.Background()

	t.Run("input guardrail blocks request with GuardrailBlockedError", func(t *testing.T) {
		guard := &mockKeywordInputGuardrail{blockedKeyword: "BAD_WORD"}
		req := &airouter.ChatRequest{
			Model: "fast",
			Messages: []airouter.ChatMessage{
				{Role: airouter.RoleUser, Content: "Hello BAD_WORD world"},
			},
		}

		err := airouter.RunInputGuardrails(ctx, []airouter.InputGuardrail{guard}, req)
		if err == nil {
			t.Fatal("expected error, got nil")
		}
		if _, ok := err.(*airouter.GuardrailBlockedError); !ok {
			t.Errorf("expected GuardrailBlockedError, got: %T (%v)", err, err)
		}
	})

	t.Run("output guardrail can rewrite response payload", func(t *testing.T) {
		guard := &mockScrubOutputGuardrail{targetWord: "SECRET"}
		req := &airouter.ChatRequest{
			Model: "fast",
			Messages: []airouter.ChatMessage{
				{Role: airouter.RoleUser, Content: "tell me a secret"},
			},
		}
		resp := &airouter.ChatResponse{
			ID:       "test-id",
			Model:    "gpt-4o",
			Provider: "openai",
			Choices: []airouter.Choice{
				{
					Index: 0,
					Message: airouter.ChatMessage{
						Role:    airouter.RoleAssistant,
						Content: "This is a SECRET phrase",
					},
				},
			},
		}

		finalResp, err := airouter.RunOutputGuardrails(ctx, []airouter.OutputGuardrail{guard}, req, resp)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		content, _ := finalResp.Choices[0].Message.Content.(string)
		if content != "This is a [REDACTED] phrase" {
			t.Errorf("expected redacted content, got %q", content)
		}
	})
}
