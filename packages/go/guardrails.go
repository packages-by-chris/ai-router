package airouter

import "context"

// GuardrailVerdict represents the result of evaluating a guardrail.
type GuardrailVerdict struct {
	Action        string // "pass" | "block" | "rewrite"
	Reason        string
	RewrittenBody any
}

// InputGuardrail inspects requests before network dispatch.
type InputGuardrail interface {
	Name() string
	Evaluate(ctx context.Context, req *ChatRequest) (GuardrailVerdict, error)
}

// OutputGuardrail inspects responses before delivery.
type OutputGuardrail interface {
	Name() string
	Evaluate(ctx context.Context, req *ChatRequest, resp *ChatResponse) (GuardrailVerdict, error)
}

// RunInputGuardrails runs all registered input guardrails.
func RunInputGuardrails(ctx context.Context, guards []InputGuardrail, req *ChatRequest) error {
	for _, g := range guards {
		v, err := g.Evaluate(ctx, req)
		if err != nil {
			return err
		}
		if v.Action == "block" {
			return &GuardrailBlockedError{
				GuardrailName: g.Name(),
				Reason:        v.Reason,
			}
		}
	}
	return nil
}

// RunOutputGuardrails runs all registered output guardrails and rewrites response if requested.
func RunOutputGuardrails(ctx context.Context, guards []OutputGuardrail, req *ChatRequest, resp *ChatResponse) (*ChatResponse, error) {
	current := resp
	for _, g := range guards {
		v, err := g.Evaluate(ctx, req, current)
		if err != nil {
			return nil, err
		}
		if v.Action == "block" {
			return nil, &GuardrailBlockedError{
				GuardrailName: g.Name(),
				Reason:        v.Reason,
			}
		}
		if v.Action == "rewrite" && v.RewrittenBody != nil {
			if rewrittenResp, ok := v.RewrittenBody.(*ChatResponse); ok {
				current = rewrittenResp
			}
		}
	}
	return current, nil
}
