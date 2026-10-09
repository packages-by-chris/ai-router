package airouter_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	airouter "github.com/ai-router-sdk/ai-router-go"
)

func TestRoutingEngine(t *testing.T) {
	ctx := context.Background()

	t.Run("falls back to secondary route when primary fails with non-retryable error", func(t *testing.T) {
		var primaryHits, backupHits int32

		primaryServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			atomic.AddInt32(&primaryHits, 1)
			http.Error(w, `{"error": "model_not_found"}`, 404)
		}))
		defer primaryServer.Close()

		backupServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			atomic.AddInt32(&backupHits, 1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"id": "resp_backup",
				"model": "claude-haiku",
				"created": 1000,
				"choices": [{"index": 0, "message": {"role": "assistant", "content": "from backup"}}]
			}`))
		}))
		defer backupServer.Close()

		cfg := &airouter.RouterConfig{
			Routes: []airouter.ModelRoute{
				{
					ID:       "primary",
					Provider: "openai-compatible",
					Model:    "gpt-primary",
					BaseURL:  primaryServer.URL,
					APIKey:   "key1",
				},
				{
					ID:       "backup",
					Provider: "openai-compatible",
					Model:    "claude-haiku",
					BaseURL:  backupServer.URL,
					APIKey:   "key2",
				},
			},
		}

		router := airouter.New(cfg, airouter.WithHTTPClient(http.DefaultClient))
		resp, err := router.Complete(ctx, airouter.ChatRequest{
			Model: "primary",
			Messages: []airouter.ChatMessage{
				{Role: airouter.RoleUser, Content: "hi"},
			},
		})

		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if resp.Provider != "backup" {
			t.Errorf("expected provider 'backup', got %q", resp.Provider)
		}
		if atomic.LoadInt32(&primaryHits) != 1 {
			t.Errorf("expected 1 hit on primary, got %d", atomic.LoadInt32(&primaryHits))
		}
		if atomic.LoadInt32(&backupHits) != 1 {
			t.Errorf("expected 1 hit on backup, got %d", atomic.LoadInt32(&backupHits))
		}
	})

	t.Run("retries on same route and rotates key on rate_limit", func(t *testing.T) {
		var key0Hits, key1Hits int32

		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			auth := r.Header.Get("Authorization")
			if auth == "Bearer key0" {
				atomic.AddInt32(&key0Hits, 1)
				w.Header().Set("Retry-After", "0")
				http.Error(w, `{"error": "rate_limit_exceeded"}`, 429)
				return
			}
			if auth == "Bearer key1" {
				atomic.AddInt32(&key1Hits, 1)
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{
					"id": "resp_ok",
					"model": "gpt-pool",
					"created": 1000,
					"choices": [{"index": 0, "message": {"role": "assistant", "content": "from key1"}}]
				}`))
				return
			}
		}))
		defer server.Close()

		maxRetries := 2
		cfg := &airouter.RouterConfig{
			Routes: []airouter.ModelRoute{
				{
					ID:         "pooled",
					Provider:   "openai-compatible",
					Model:      "gpt-pool",
					BaseURL:    server.URL,
					APIKeys:    []string{"key0", "key1"},
					MaxRetries: &maxRetries,
				},
			},
		}

		router := airouter.New(cfg, airouter.WithHTTPClient(http.DefaultClient))
		resp, err := router.Complete(ctx, airouter.ChatRequest{
			Model: "pooled",
			Messages: []airouter.ChatMessage{
				{Role: airouter.RoleUser, Content: "test key rotation"},
			},
		})

		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if atomic.LoadInt32(&key0Hits) < 1 {
			t.Errorf("expected key0 to receive hit, got %d", atomic.LoadInt32(&key0Hits))
		}
		if atomic.LoadInt32(&key1Hits) < 1 {
			t.Errorf("expected key1 to receive hit, got %d", atomic.LoadInt32(&key1Hits))
		}
		if resp.Choices[0].Message.Content != "from key1" {
			t.Errorf("unexpected content: %v", resp.Choices[0].Message.Content)
		}
	})

	t.Run("streaming commit boundary allows fallback if first stream fails before first token", func(t *testing.T) {
		server1 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, `server error`, 500)
		}))
		defer server1.Close()

		server2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(200)
			_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":\"chunk 1\"}}]}\n\n")
			_, _ = fmt.Fprintf(w, "data: [DONE]\n\n")
		}))
		defer server2.Close()

		cfg := &airouter.RouterConfig{
			Routes: []airouter.ModelRoute{
				{
					ID:       "s1",
					Provider: "openai-compatible",
					Model:    "m1",
					BaseURL:  server1.URL,
					APIKey:   "k1",
				},
				{
					ID:       "s2",
					Provider: "openai-compatible",
					Model:    "m2",
					BaseURL:  server2.URL,
					APIKey:   "k2",
				},
			},
		}

		router := airouter.New(cfg, airouter.WithHTTPClient(http.DefaultClient))
		chunks, errs := router.Stream(ctx, airouter.ChatRequest{
			Model: "s1",
			Messages: []airouter.ChatMessage{
				{Role: airouter.RoleUser, Content: "stream test"},
			},
		})

		text, err := airouter.StreamText(ctx, chunks, errs)
		if err != nil {
			t.Fatalf("unexpected stream error: %v", err)
		}
		if text != "chunk 1" {
			t.Errorf("expected 'chunk 1', got %q", text)
		}
	})
}
