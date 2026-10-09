package airouter_test

import (
	"testing"

	airouter "github.com/ai-router-sdk/ai-router-go"
)

func TestMemoryStore(t *testing.T) {
	fakeNow := int64(1000000)
	store := airouter.NewMemoryStore(func() int64 {
		return fakeNow
	})

	t.Run("permits within limit and blocks on excess", func(t *testing.T) {
		// RPM = 3
		d1, err := store.Take("test:rpm", 1, 60000, 3)
		if err != nil || !d1.Allowed {
			t.Fatalf("call 1 should be allowed, got: %+v, err: %v", d1, err)
		}

		d2, err := store.Take("test:rpm", 1, 60000, 3)
		if err != nil || !d2.Allowed {
			t.Fatalf("call 2 should be allowed, got: %+v, err: %v", d2, err)
		}

		d3, err := store.Take("test:rpm", 1, 60000, 3)
		if err != nil || !d3.Allowed {
			t.Fatalf("call 3 should be allowed, got: %+v, err: %v", d3, err)
		}

		// 4th call should be blocked
		d4, err := store.Take("test:rpm", 1, 60000, 3)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if d4.Allowed {
			t.Fatalf("call 4 should be blocked")
		}
		if d4.RetryAfterMs <= 0 {
			t.Errorf("expected positive retryAfterMs, got %d", d4.RetryAfterMs)
		}

		// Advance time past window
		fakeNow += 60001
		d5, err := store.Take("test:rpm", 1, 60000, 3)
		if err != nil || !d5.Allowed {
			t.Fatalf("call 5 after window expiry should be allowed, got: %+v, err: %v", d5, err)
		}
	})

	t.Run("records post-hoc token usage", func(t *testing.T) {
		err := store.Record("test:tpm", 500, 60000)
		if err != nil {
			t.Fatalf("failed to record tokens: %v", err)
		}
	})
}
