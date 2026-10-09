package airouter

import (
	"sync"
	"time"
)

// RateLimitDecision represents whether a request is admitted.
type RateLimitDecision struct {
	Allowed      bool
	RetryAfterMs int
}

// RateLimitStore is the contract for rate-limiting stores (memory, Redis, etc.).
type RateLimitStore interface {
	Take(key string, cost int, windowMs int64, limit int) (RateLimitDecision, error)
	Record(key string, cost int, windowMs int64) error
}

type limiterEntry struct {
	ts   int64
	cost int
}

// MemoryStore provides an in-process thread-safe sliding-window log.
type MemoryStore struct {
	mu      sync.Mutex
	entries map[string][]limiterEntry
	nowFn   func() int64
}

// NewMemoryStore creates a new in-memory rate limit store.
func NewMemoryStore(nowFn ...func() int64) *MemoryStore {
	fn := func() int64 {
		return time.Now().UnixMilli()
	}
	if len(nowFn) > 0 && nowFn[0] != nil {
		fn = nowFn[0]
	}
	return &MemoryStore{
		entries: make(map[string][]limiterEntry),
		nowFn:   fn,
	}
}

func (s *MemoryStore) prune(key string, windowMs int64) []limiterEntry {
	list := s.entries[key]
	cutoff := s.nowFn() - windowMs
	var active []limiterEntry
	for _, e := range list {
		if e.ts > cutoff {
			active = append(active, e)
		}
	}
	s.entries[key] = active
	return active
}

func (s *MemoryStore) Take(key string, cost int, windowMs int64, limit int) (RateLimitDecision, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	list := s.prune(key, windowMs)
	used := 0
	for _, e := range list {
		used += e.cost
	}

	if used+cost <= limit {
		s.entries[key] = append(s.entries[key], limiterEntry{
			ts:   s.nowFn(),
			cost: cost,
		})
		return RateLimitDecision{Allowed: true, RetryAfterMs: 0}, nil
	}

	retryAfterMs := 1
	if len(list) > 0 {
		diff := list[0].ts + windowMs - s.nowFn()
		if diff > 1 {
			retryAfterMs = int(diff)
		}
	}

	return RateLimitDecision{Allowed: false, RetryAfterMs: retryAfterMs}, nil
}

func (s *MemoryStore) Record(key string, cost int, windowMs int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.prune(key, windowMs)
	s.entries[key] = append(s.entries[key], limiterEntry{
		ts:   s.nowFn(),
		cost: cost,
	})
	return nil
}
