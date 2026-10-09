package airouter

import (
	"context"
	"fmt"
	"math/rand"
	"net/http"
	"time"
)

// EngineOption configures the RoutingEngine.
type EngineOption func(*RoutingEngine)

// WithHTTPClient overrides the HTTP client.
func WithHTTPClient(client *http.Client) EngineOption {
	return func(e *RoutingEngine) {
		e.httpClient = client
	}
}

// WithLimiterStore sets a custom rate limit store.
func WithLimiterStore(store RateLimitStore) EngineOption {
	return func(e *RoutingEngine) {
		e.limiter = store
	}
}

// WithInputGuardrails adds input guardrails.
func WithInputGuardrails(guards ...InputGuardrail) EngineOption {
	return func(e *RoutingEngine) {
		e.inputGuards = append(e.inputGuards, guards...)
	}
}

// WithOutputGuardrails adds output guardrails.
func WithOutputGuardrails(guards ...OutputGuardrail) EngineOption {
	return func(e *RoutingEngine) {
		e.outputGuards = append(e.outputGuards, guards...)
	}
}

// RoutingEngine coordinates routing, retries, fallback chains, and recovery.
type RoutingEngine struct {
	config       *RouterConfig
	routes       []*NormalizedRoute
	routesByID   map[string]*NormalizedRoute
	httpClient   *http.Client
	limiter      RateLimitStore
	health       *HealthTracker
	inputGuards  []InputGuardrail
	outputGuards []OutputGuardrail
}

// NewRoutingEngine initializes an engine from validated configuration.
func NewRoutingEngine(cfg *RouterConfig, opts ...EngineOption) *RoutingEngine {
	var normRoutes []*NormalizedRoute
	routesMap := make(map[string]*NormalizedRoute)

	for i := range cfg.Routes {
		nr := NormalizeRoute(&cfg.Routes[i])
		normRoutes = append(normRoutes, nr)
		routesMap[nr.ID] = nr
	}

	eng := &RoutingEngine{
		config:     cfg,
		routes:     normRoutes,
		routesByID: routesMap,
		httpClient: &http.Client{Timeout: 60 * time.Second},
		limiter:    NewMemoryStore(),
		health:     NewHealthTracker(),
	}

	for _, opt := range opts {
		opt(eng)
	}

	return eng
}

func (e *RoutingEngine) getCandidates(req *ChatRequest) ([]*NormalizedRoute, error) {
	// If requested model matches a route ID, try that route and remaining routes as fallback
	var candidates []*NormalizedRoute
	if target, ok := e.routesByID[req.Model]; ok {
		candidates = append(candidates, target)
		for _, r := range e.routes {
			if r.ID != target.ID {
				candidates = append(candidates, r)
			}
		}
	} else {
		candidates = append(candidates, e.routes...)
	}

	admitted, _ := FilterByCapabilities(candidates, req)
	if len(admitted) == 0 {
		return nil, &AllRoutesFailedError{
			Message: fmt.Sprintf("no candidate routes capable of serving model %q", req.Model),
		}
	}

	ordered := OrderCandidates(admitted, e.config.Strategy, e.config.Weights, e.health, req)
	return ordered, nil
}

func (e *RoutingEngine) Complete(ctx context.Context, req *ChatRequest, callOpts ...CallOptions) (*ChatResponse, error) {
	var opts CallOptions
	if len(callOpts) > 0 {
		opts = callOpts[0]
	}

	if err := RunInputGuardrails(ctx, e.inputGuards, req); err != nil {
		return nil, err
	}

	candidates, err := e.getCandidates(req)
	if err != nil {
		return nil, err
	}

	var attempts []AttemptRecord

	for _, route := range candidates {
		if e.health.IsCircuitOpen(route.ID) {
			attempts = append(attempts, AttemptRecord{
				RouteID:  route.ID,
				Provider: route.Provider,
				Model:    route.Model,
				Outcome:  "circuit_open",
			})
			continue
		}

		adapter, ok := GetAdapter(route.AdapterID)
		if !ok {
			attempts = append(attempts, AttemptRecord{
				RouteID:  route.ID,
				Provider: route.Provider,
				Model:    route.Model,
				Outcome:  "unsupported",
			})
			continue
		}

		// Rate limit preflight
		if route.Limit != nil && route.Limit.RPM > 0 {
			dec, err := e.limiter.Take(route.ID+":rpm", 1, 60000, route.Limit.RPM)
			if err == nil && !dec.Allowed {
				attempts = append(attempts, AttemptRecord{
					RouteID:      route.ID,
					Provider:     route.Provider,
					Model:        route.Model,
					Outcome:      "skipped_rate_limit",
					RetryAfterMs: dec.RetryAfterMs,
				})
				continue
			}
		}

		for attempt := 0; attempt <= route.MaxRetries; attempt++ {
			apiKey, keyIdx := e.health.NextUsableKey(route.ID, route.APIKeys)
			start := time.Now()

			resp, err := adapter.Execute(ctx, route, apiKey, req, e.httpClient)
			duration := time.Since(start).Milliseconds()

			if err == nil {
				e.health.RecordSuccess(route.ID, keyIdx, duration, false)
				if opts.OnAttempt != nil {
					opts.OnAttempt(AttemptEvent{
						RouteID:  route.ID,
						Provider: route.Provider,
						Model:    route.Model,
						KeyIndex: keyIdx,
						Attempt:  attempt + 1,
						Duration: duration,
					})
				}
				// Record token rate limits post-hoc
				if resp.Usage != nil && route.Limit != nil && route.Limit.TPM > 0 {
					_ = e.limiter.Record(route.ID+":tpm", resp.Usage.TotalTokens, 60000)
				}
				// Run output guardrails
				return RunOutputGuardrails(ctx, e.outputGuards, req, resp)
			}

			// Handle failure
			var kind ErrorKind = ErrorKindUnknown
			retryAfter := 0
			if pe, ok := err.(*ProviderError); ok {
				kind = pe.Kind
				retryAfter = pe.RetryAfterMs
			}

			e.health.RecordFailure(route.ID, keyIdx, kind, retryAfter)
			if opts.OnAttempt != nil {
				opts.OnAttempt(AttemptEvent{
					RouteID:  route.ID,
					Provider: route.Provider,
					Model:    route.Model,
					KeyIndex: keyIdx,
					Attempt:  attempt + 1,
					Duration: duration,
					Error:    err,
					Kind:     kind,
				})
			}

			attempts = append(attempts, AttemptRecord{
				RouteID:      route.ID,
				Provider:     route.Provider,
				Model:        route.Model,
				Outcome:      "error",
				Attempts:     attempt + 1,
				KeyIndex:     &keyIdx,
				Kind:         kind,
				Message:      err.Error(),
				RetryAfterMs: retryAfter,
			})

			if !IsRetryableKind(kind) && !IsKeyRelatedKind(kind) {
				break // Route exhausted immediately
			}

			if attempt < route.MaxRetries {
				sleepMs := int64(100 * (1 << attempt))
				if retryAfter > 0 {
					sleepMs = int64(retryAfter)
				} else {
					sleepMs += rand.Int63n(50)
				}
				select {
				case <-ctx.Done():
					return nil, ctx.Err()
				case <-time.After(time.Duration(sleepMs) * time.Millisecond):
				}
			}
		}
	}

	return nil, &AllRoutesFailedError{Attempts: attempts}
}

func (e *RoutingEngine) Stream(ctx context.Context, req *ChatRequest, callOpts ...CallOptions) (<-chan ChatChunk, <-chan error) {
	outChunks := make(chan ChatChunk, 50)
	outErrs := make(chan error, 1)

	go func() {
		defer close(outChunks)
		defer close(outErrs)

		if err := RunInputGuardrails(ctx, e.inputGuards, req); err != nil {
			outErrs <- err
			return
		}

		candidates, err := e.getCandidates(req)
		if err != nil {
			outErrs <- err
			return
		}

		var attempts []AttemptRecord

		for _, route := range candidates {
			if e.health.IsCircuitOpen(route.ID) {
				attempts = append(attempts, AttemptRecord{
					RouteID:  route.ID,
					Provider: route.Provider,
					Model:    route.Model,
					Outcome:  "circuit_open",
				})
				continue
			}

			adapter, ok := GetAdapter(route.AdapterID)
			if !ok {
				attempts = append(attempts, AttemptRecord{
					RouteID:  route.ID,
					Provider: route.Provider,
					Model:    route.Model,
					Outcome:  "unsupported",
				})
				continue
			}

			apiKey, keyIdx := e.health.NextUsableKey(route.ID, route.APIKeys)
			chunks, errs, err := adapter.ExecuteStream(ctx, route, apiKey, req, e.httpClient)

			if err != nil {
				// Failed before stream started, record & fallback
				var kind ErrorKind = ErrorKindUnknown
				retryAfter := 0
				if pe, ok := err.(*ProviderError); ok {
					kind = pe.Kind
					retryAfter = pe.RetryAfterMs
				}
				e.health.RecordFailure(route.ID, keyIdx, kind, retryAfter)
				attempts = append(attempts, AttemptRecord{
					RouteID:      route.ID,
					Provider:     route.Provider,
					Model:        route.Model,
					Outcome:      "error",
					KeyIndex:     &keyIdx,
					Kind:         kind,
					Message:      err.Error(),
					RetryAfterMs: retryAfter,
				})
				continue
			}

			committed := false
			streamSuccess := true

			for {
				select {
				case <-ctx.Done():
					outErrs <- ctx.Err()
					return
				case streamErr, ok := <-errs:
					if ok && streamErr != nil {
						if committed {
							// Stream was already committed, cannot fall back without duplicating tokens
							outErrs <- streamErr
							return
						}
						// Error before first token, allow fallback to next route
						streamSuccess = false
						var kind ErrorKind = ErrorKindUnknown
						if pe, ok := streamErr.(*ProviderError); ok {
							kind = pe.Kind
						}
						e.health.RecordFailure(route.ID, keyIdx, kind, 0)
						attempts = append(attempts, AttemptRecord{
							RouteID:  route.ID,
							Provider: route.Provider,
							Model:    route.Model,
							Outcome:  "error",
							Kind:     kind,
							Message:  streamErr.Error(),
						})
					}
				case chunk, ok := <-chunks:
					if !ok {
						goto STREAM_DONE
					}
					committed = true
					outChunks <- chunk
				}
				if !streamSuccess {
					break
				}
			}

		STREAM_DONE:
			if streamSuccess && committed {
				e.health.RecordSuccess(route.ID, keyIdx, 0, true)
				return
			}
		}

		outErrs <- &AllRoutesFailedError{Attempts: attempts}
	}()

	return outChunks, outErrs
}

func (e *RoutingEngine) Raw(ctx context.Context, req RawRequest) (*http.Response, error) {
	route, ok := e.routesByID[req.RouteID]
	if !ok {
		return nil, &ConfigError{Message: fmt.Sprintf("unknown route id: %s", req.RouteID)}
	}
	adapter, ok := GetAdapter(route.AdapterID)
	if !ok {
		return nil, &UnsupportedProviderError{Provider: route.Provider}
	}
	apiKey, _ := e.health.NextUsableKey(route.ID, route.APIKeys)
	return adapter.ExecuteRaw(ctx, route, apiKey, RawRequestOptions{
		Path: req.Path,
		Body: req.Body,
	}, e.httpClient)
}

func (e *RoutingEngine) Embed(ctx context.Context, req *EmbeddingRequest) (*EmbeddingResponse, error) {
	targetRoute, ok := e.routesByID[req.Model]
	if !ok {
		if len(e.routes) > 0 {
			targetRoute = e.routes[0]
		} else {
			return nil, &ConfigError{Message: "no routes available"}
		}
	}
	adapter, ok := GetAdapter(targetRoute.AdapterID)
	if !ok {
		return nil, &UnsupportedProviderError{Provider: targetRoute.Provider}
	}
	apiKey, _ := e.health.NextUsableKey(targetRoute.ID, targetRoute.APIKeys)
	return adapter.Embed(ctx, targetRoute, apiKey, req, e.httpClient)
}

// Stats returns health snapshots for all routes.
func (e *RoutingEngine) Stats() map[string]RouteHealthSnapshot {
	out := make(map[string]RouteHealthSnapshot)
	for _, r := range e.routes {
		out[r.ID] = e.health.Snapshot(r.ID, len(r.APIKeys))
	}
	return out
}
