package airouter_test

import (
	"testing"

	airouter "github.com/ai-router-sdk/ai-router-go"
)

func TestHealthTracker(t *testing.T) {
	fakeNow := int64(1000000)
	health := airouter.NewHealthTracker(func() int64 {
		return fakeNow
	})

	t.Run("tracks successes and latencies", func(t *testing.T) {
		health.RecordSuccess("route-a", 0, 150, false)
		health.RecordSuccess("route-a", 0, 200, false)
		health.RecordSuccess("route-a", 0, 250, false)

		snap := health.Snapshot("route-a", 1)
		if snap.Successes != 3 {
			t.Errorf("expected 3 successes, got %d", snap.Successes)
		}
		if snap.P50LatencyMs == nil || *snap.P50LatencyMs != 200 {
			t.Errorf("expected p50 of 200, got %v", snap.P50LatencyMs)
		}
	})

	t.Run("cooldowns keys on rate limit failures", func(t *testing.T) {
		keyPool := []string{"key-0", "key-1"}

		// Trigger 429 on key 0 with 5000ms retryAfter
		health.RecordFailure("route-b", 0, airouter.ErrorKindRateLimit, 5000)

		// Next key should be key-1
		key, idx := health.NextUsableKey("route-b", keyPool)
		if idx != 1 || key != "key-1" {
			t.Errorf("expected key-1 (idx 1), got key %s (idx %d)", key, idx)
		}

		// Advance time past cooldown
		fakeNow += 5001
		keyAfter, idxAfter := health.NextUsableKey("route-b", keyPool)
		if idxAfter != 0 || keyAfter != "key-0" {
			t.Errorf("expected key-0 after cooldown expiration, got key %s (idx %d)", keyAfter, idxAfter)
		}
	})

	t.Run("Wilson lower bound produces conservative estimates under uncertainty", func(t *testing.T) {
		// 3/3 lucky attempts should have lower confidence than 95/100
		lbSmall := airouter.WilsonLowerBound(3, 3)
		lbLarge := airouter.WilsonLowerBound(95, 100)

		if lbSmall >= lbLarge {
			t.Errorf("expected 95/100 lower bound (%f) to exceed 3/3 lower bound (%f)", lbLarge, lbSmall)
		}
	})
}
