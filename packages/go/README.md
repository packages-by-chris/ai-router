# ai-router-go

**Embeddable, provider-agnostic AI routing engine for Go.**

`ai-router-go` (`github.com/ai-router-sdk/ai-router-go`) brings the routing, reliability, and governance capabilities of an AI gateway directly into your Go applications without operating a separate proxy service. It runs in-process, talks to LLM providers directly over their native APIs, and handles:

- **Ordered fallback chains** across models, tiers, and providers.
- **Smart routing strategies**: `fallback`, `round-robin`, `weighted`, `least-latency`, `cheapest`, `balanced`, `quality-first`.
- **In-memory sliding-window rate limiting** (RPM / TPM) & **spend budget caps** (USD).
- **Statistical health tracking** (Wilson lower-bound scoring, latency EMA, adaptive error backoff).
- **Key-pool rotation & circuit breaking**.
- **Real-time streaming via Go channels** (`<-chan ChatChunk`, `<-chan error`) with commit-boundary guarantees.
- **Pluggable Input / Output Guardrails** to block or rewrite prompts and completions.
- **Zero external runtime dependencies** — built exclusively with the Go standard library (`net/http`, `crypto`, `context`).

---

## Installation

```bash
go get github.com/ai-router-sdk/ai-router-go
```

Go 1.21 or higher is required.

---

## Quick Start

### 1. Unified Completions with Automatic Fallback

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

	// 1. Initialize router with declarative routes
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
			map[string]any{
				"id":       "backup-gemini",
				"provider": "gemini",
				"model":    "gemini-2.0-flash",
				"apiKey":   "${GEMINI_API_KEY}",
			},
		},
	})
	if err != nil {
		log.Fatalf("failed to initialize router: %v", err)
	}

	// 2. Complete request — model is a route id, not a provider model name
	resp, err := router.Complete(ctx, airouter.ChatRequest{
		Model: "fast",
		Messages: []airouter.ChatMessage{
			{Role: airouter.RoleUser, Content: "Explain distributed consensus in two sentences."},
		},
	})
	if err != nil {
		log.Fatalf("completion error: %v", err)
	}

	fmt.Println(resp.Choices[0].Message.Content)
	fmt.Printf("Served by: %s (%s)\n", resp.Provider, resp.Model)
}
```

---

### 2. Real-Time Channel Streaming

Streaming uses standard Go channels with a **committed stream contract**: attempt events and retries occur before the first token, ensuring zero duplicate or partial tokens once streaming begins.

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
	router, _ := airouter.NewFromMap(map[string]any{
		"routes": []any{
			map[string]any{"id": "fast", "provider": "openai", "model": "gpt-4o-mini", "apiKey": "${OPENAI_API_KEY}"},
		},
	})

	chunks, errs := router.Stream(ctx, airouter.ChatRequest{
		Model: "fast",
		Messages: []airouter.ChatMessage{
			{Role: airouter.RoleUser, Content: "Count from 1 to 10 with a brief note for each."},
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

Or collect the entire stream into a single string using `airouter.StreamText`:

```go
fullText, err := airouter.StreamText(ctx, chunks, errs)
if err != nil {
	log.Fatal(err)
}
fmt.Println(fullText)
```

---

### 3. Tool Calling

Tool schemas and invocations are normalized across OpenAI, Anthropic, Gemini, AWS Bedrock, and Azure:

```go
req := airouter.ChatRequest{
	Model: "fast",
	Messages: []airouter.ChatMessage{
		{Role: airouter.RoleUser, Content: "What is the weather in Tokyo?"},
	},
	Tools: []airouter.Tool{
		{
			Type: "function",
			Function: airouter.FunctionDef{
				Name:        "get_weather",
				Description: "Get current weather for a city",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"location": map[string]any{"type": "string"},
					},
					"required": []any{"location"},
				},
			},
		},
	},
}

resp, err := router.Complete(ctx, req)
if err != nil {
	log.Fatal(err)
}

for _, call := range resp.Choices[0].Message.ToolCalls {
	fmt.Printf("Function: %s, Args: %s\n", call.Function.Name, call.Function.Arguments)
}
```

---

### 4. Input & Output Guardrails

Inspect, block, or sanitize requests and responses:

```go
inputGuard := airouter.InputGuardrail{
	Name: "block-secrets",
	Check: func(ctx context.Context, req airouter.ChatRequest) (airouter.GuardrailVerdict, error) {
		for _, m := range req.Messages {
			if str, ok := m.Content.(string); ok && strings.Contains(str, "SECRET_TOKEN") {
				return airouter.GuardrailVerdict{
					Pass:   false,
					Reason: "prompt contains confidential token",
				}, nil
			}
		}
		return airouter.GuardrailVerdict{Pass: true}, nil
	},
}

router := airouter.New(config, airouter.WithGuardrails(airouter.Guardrails{
	Input: []airouter.InputGuardrail{inputGuard},
}))
```

---

### 5. Circuit Breaker & Health Tracking

Automatically trip failing routes and divert traffic to healthy backups:

```go
router := airouter.New(config, airouter.WithCircuitBreaker(airouter.CircuitBreakerOptions{
	Threshold:   3,                // trip after 3 consecutive failures
	Cooldown:    30 * time.Second, // wait 30s before half-open probe
	MaxCooldown: 5 * time.Minute,  // exponential backoff cap
}))
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

The Go SDK is verified against the unified cross-SDK test suite (`packages/core/conformance/cases/*.json`) to guarantee 100% wire translation parity across TypeScript, Python, Dart, and Go:

```bash
cd packages/go
go test -v ./...
```

---

## License

[MIT](../../LICENSE)
