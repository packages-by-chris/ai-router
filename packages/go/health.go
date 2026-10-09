package airouter

import (
	"math"
	"sort"
	"sync"
	"time"
)

// KeyHealth captures failures and active cooldowns for an individual API key.
type KeyHealth struct {
	KeyIndex            int   `json:"keyIndex"`
	Failures            int   `json:"failures"`
	CooldownRemainingMs int64 `json:"cooldownRemainingMs"`
}

// OpLatencyPercentiles holds percentile latency statistics.
type OpLatencyPercentiles struct {
	P50Ms   *float64              `json:"p50Ms,omitempty"`
	P95Ms   *float64              `json:"p95Ms,omitempty"`
	P99Ms   *float64              `json:"p99Ms,omitempty"`
	Samples int                   `json:"samples"`
	TTFB    *OpLatencyPercentiles `json:"ttfb,omitempty"`
}

// RouteHealthSnapshot captures health stats for a route.
type RouteHealthSnapshot struct {
	RouteID      string                 `json:"routeId"`
	Successes    int                    `json:"successes"`
	Failures     int                    `json:"failures"`
	ByKind       map[ErrorKind]int      `json:"byKind"`
	SuccessRate  float64                `json:"successRate"`
	P50LatencyMs *float64               `json:"p50LatencyMs,omitempty"`
	P95LatencyMs *float64               `json:"p95LatencyMs,omitempty"`
	P99LatencyMs *float64               `json:"p99LatencyMs,omitempty"`
	Keys         []KeyHealth            `json:"keys"`
	SuccessLB    *float64               `json:"successLb,omitempty"`
	Complete     *OpLatencyPercentiles  `json:"complete,omitempty"`
	Stream       *OpLatencyPercentiles  `json:"stream,omitempty"`
}

type timedRing struct {
	buf  []float64
	ts   []int64
	size int
	head int
}

func newTimedRing(capacity int) *timedRing {
	return &timedRing{
		buf: make([]float64, capacity),
		ts:  make([]int64, capacity),
	}
}

func (r *timedRing) push(val float64, now int64) {
	r.buf[r.head] = val
	r.ts[r.head] = now
	r.head = (r.head + 1) % len(r.buf)
	if r.size < len(r.buf) {
		r.size++
	}
}

func (r *timedRing) percentiles(now int64, ttlMs int64) (p50, p95, p99 *float64, count int) {
	cutoff := now - ttlMs
	var active []float64
	for i := 0; i < r.size; i++ {
		idx := (r.head - 1 - i + len(r.buf)) % len(r.buf)
		if r.ts[idx] > cutoff {
			active = append(active, r.buf[idx])
		}
	}
	count = len(active)
	if count == 0 {
		return nil, nil, nil, 0
	}
	sort.Float64s(active)

	getPercentile := func(p float64) *float64 {
		pos := p * float64(count-1)
		idx := int(math.Floor(pos))
		val := active[idx]
		return &val
	}

	return getPercentile(0.50), getPercentile(0.95), getPercentile(0.99), count
}

type routeState struct {
	successes       int
	failures        int
	byKind          map[ErrorKind]int
	completeRing    *timedRing
	streamRing      *timedRing
	keyFailures     map[int]int
	keyCooldownUntils map[int]int64
	circuitOpenUntil int64
	consecutiveFails int
}

// HealthTracker tracks success rates, latency percentiles, and circuit breakers.
type HealthTracker struct {
	mu     sync.RWMutex
	routes map[string]*routeState
	nowFn  func() int64
}

// NewHealthTracker creates a new thread-safe health tracker.
func NewHealthTracker(nowFn ...func() int64) *HealthTracker {
	fn := func() int64 {
		return time.Now().UnixMilli()
	}
	if len(nowFn) > 0 && nowFn[0] != nil {
		fn = nowFn[0]
	}
	return &HealthTracker{
		routes: make(map[string]*routeState),
		nowFn:  fn,
	}
}

func (h *HealthTracker) getOrCreate(routeID string) *routeState {
	st, ok := h.routes[routeID]
	if !ok {
		st = &routeState{
			byKind:            make(map[ErrorKind]int),
			completeRing:      newTimedRing(128),
			streamRing:        newTimedRing(128),
			keyFailures:       make(map[int]int),
			keyCooldownUntils: make(map[int]int64),
		}
		h.routes[routeID] = st
	}
	return st
}

// RecordSuccess registers a successful completion/stream.
func (h *HealthTracker) RecordSuccess(routeID string, keyIndex int, durationMs int64, isStream bool) {
	h.mu.Lock()
	defer h.mu.Unlock()

	st := h.getOrCreate(routeID)
	st.successes++
	st.consecutiveFails = 0
	now := h.nowFn()
	if isStream {
		st.streamRing.push(float64(durationMs), now)
	} else {
		st.completeRing.push(float64(durationMs), now)
	}
}

// RecordFailure registers an error and triggers cooldowns / circuit breaking if needed.
func (h *HealthTracker) RecordFailure(routeID string, keyIndex int, kind ErrorKind, retryAfterMs int) {
	h.mu.Lock()
	defer h.mu.Unlock()

	st := h.getOrCreate(routeID)
	st.failures++
	st.consecutiveFails++
	st.byKind[kind]++
	st.keyFailures[keyIndex]++

	now := h.nowFn()
	if kind == ErrorKindRateLimit {
		cd := int64(retryAfterMs)
		if cd <= 0 {
			fails := st.keyFailures[keyIndex]
			cd = int64(math.Min(float64(5*60*1000), math.Pow(2, float64(fails-1))*1000))
		}
		st.keyCooldownUntils[keyIndex] = now + cd
	}

	if st.consecutiveFails >= 5 {
		st.circuitOpenUntil = now + 30000 // 30s cooldown
	}
}

// IsCircuitOpen checks if the route is currently circuit-broken.
func (h *HealthTracker) IsCircuitOpen(routeID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()

	st, ok := h.routes[routeID]
	if !ok {
		return false
	}
	return h.nowFn() < st.circuitOpenUntil
}

// NextUsableKey selects a key that is not in active cooldown.
func (h *HealthTracker) NextUsableKey(routeID string, keyPool []string) (string, int) {
	if len(keyPool) == 0 {
		return "", 0
	}
	h.mu.RLock()
	defer h.mu.RUnlock()

	st, ok := h.routes[routeID]
	if !ok {
		return keyPool[0], 0
	}

	now := h.nowFn()
	for i, key := range keyPool {
		if until, ok := st.keyCooldownUntils[i]; !ok || now >= until {
			return key, i
		}
	}
	// All in cooldown, return first
	return keyPool[0], 0
}

// WilsonLowerBound calculates 95% confidence lower bound for success rate.
func WilsonLowerBound(successes, total int, z ...float64) float64 {
	if total == 0 {
		return 0.5
	}
	zVal := 1.96
	if len(z) > 0 {
		zVal = z[0]
	}
	p := float64(successes) / float64(total)
	n := float64(total)
	z2 := zVal * zVal

	numerator := p + z2/(2*n) - zVal*math.Sqrt((p*(1-p)+z2/(4*n))/n)
	denominator := 1 + z2/n
	return numerator / denominator
}

// Snapshot returns health stats for a route.
func (h *HealthTracker) Snapshot(routeID string, keyPoolSize int) RouteHealthSnapshot {
	h.mu.RLock()
	defer h.mu.RUnlock()

	st, ok := h.routes[routeID]
	if !ok {
		return RouteHealthSnapshot{
			RouteID:     routeID,
			ByKind:      make(map[ErrorKind]int),
			SuccessRate: 1.0,
			Keys:        make([]KeyHealth, keyPoolSize),
		}
	}

	now := h.nowFn()
	p50, p95, p99, samples := st.completeRing.percentiles(now, 10*60*1000)
	tot := st.successes + st.failures
	rate := 1.0
	if tot > 0 {
		rate = float64(st.successes) / float64(tot)
	}
	lb := WilsonLowerBound(st.successes, tot)

	var keys []KeyHealth
	for i := 0; i < keyPoolSize; i++ {
		rem := int64(0)
		if until, ok := st.keyCooldownUntils[i]; ok && until > now {
			rem = until - now
		}
		keys = append(keys, KeyHealth{
			KeyIndex:            i,
			Failures:            st.keyFailures[i],
			CooldownRemainingMs: rem,
		})
	}

	return RouteHealthSnapshot{
		RouteID:      routeID,
		Successes:    st.successes,
		Failures:     st.failures,
		ByKind:       st.byKind,
		SuccessRate:  rate,
		P50LatencyMs: p50,
		P95LatencyMs: p95,
		P99LatencyMs: p99,
		Keys:         keys,
		SuccessLB:    &lb,
		Complete: &OpLatencyPercentiles{
			P50Ms:   p50,
			P95Ms:   p95,
			P99Ms:   p99,
			Samples: samples,
		},
	}
}
