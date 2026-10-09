# ai-router-go

Embeddable, provider-agnostic AI routing SDK for Go: fallback chains, key pools, rate limiting, and unified streaming across OpenAI, Anthropic, Gemini, Azure, Bedrock, Vertex, and OpenAI-compatible endpoints.

Zero external runtime dependencies — standard library only (`net/http`, `crypto`, `context`).

## Installation

```bash
go get github.com/ai-router-sdk/ai-router-go
```

## Quick Start

```go
package main

import (
	"context"
	"fmt"
	"log"

	airouter "github.com/ai-router-sdk/ai-router-go"
)

func main() {
	ctx := context.Background()

	// 1. Define configuration with fallback routes & rate limits
	router, err := airouter.NewFromMap(map[string]any{
		"strategy": "fallback",
		"routes": []any{
			map[string]any{
				"id":       "fast",
				"provider": "openai",
				"model":    "gpt-4o-mini",
				"apiKey":   "${OPENAI_API_KEY}",
				"limit":    map[string]any{"rpm": 500},
			},
			map[string]any{
				"id":       "backup-anthropic",
				"provider": "anthropic",
				"model":    "claude-3-5-haiku-20241022",
				"apiKey":   "${ANTHROPIC_API_KEY}",
			},
		},
	})
	if err != nil {
		log.Fatalf("failed to initialize router: %v", err)
	}

	// 2. Complete requests with automatic fallback & key rotation
	resp, err := router.Complete(ctx, airouter.ChatRequest{
		Model: "fast", // logical route id
		Messages: []airouter.ChatMessage{
			{Role: airouter.RoleUser, Content: "Explain quantum computing in one sentence."},
		},
	})
	if err != nil {
		log.Fatalf("completion error: %v", err)
	}

	fmt.Println(resp.Choices[0].Message.Content)
	fmt.Printf("Served by: %s\n", resp.Provider)

	// 3. Stream tokens in real-time via Go channels
	chunks, errs := router.Stream(ctx, airouter.ChatRequest{
		Model: "fast",
		Messages: []airouter.ChatMessage{
			{Role: airouter.RoleUser, Content: "Count from 1 to 5."},
		},
	})

	for {
		select {
		case err, ok := <-errs:
			if ok && err != nil {
				log.Fatalf("stream error: %v", err)
			}
		case chunk, ok := <-chunks:
			if !ok {
				return
			}
			if chunk.Delta.Content != nil {
				fmt.Print(*chunk.Delta.Content)
			}
		}
	}
}
```

## Features

- **Multi-Provider Unified API**: OpenAI, Anthropic Claude, Google Gemini, AWS Bedrock Converse (with built-in AWS SigV4 signing), Google Cloud Vertex AI, Azure OpenAI, and generic OpenAI-compatible providers.
- **Ordered Fallback Chains & Key Pools**: Automatic key rotation on rate-limits (HTTP 429) and transparent failover across providers.
- **7 Routing Strategies**: `fallback`, `round-robin`, `weighted`, `least-latency`, `cheapest`, `quality-first`, and `balanced`.
- **In-Memory Sliding-Window Rate Limiting**: Request and token rate limits (`rpm`, `tpm`).
- **Streaming Commit Boundary**: Allows clean retries before the first byte, but guarantees at-most-once delivery without token duplication once streaming begins.
- **Guardrails**: Pluggable input and output guardrails to block prompt injections or scrub sensitive output tokens.
- **Zero External Runtime Dependencies**: Standard library only.

## Testing & Conformance

Run unit tests and cross-SDK JSON conformance suites:

```bash
cd packages/go
go test -v ./...
```

## License

MIT
