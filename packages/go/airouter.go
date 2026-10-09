package airouter

import (
	"context"
	"net/http"
)

// AIRouter is the main client facade.
type AIRouter struct {
	engine *RoutingEngine
}

// New creates and initializes an AIRouter instance from a RouterConfig.
func New(config *RouterConfig, opts ...EngineOption) *AIRouter {
	return &AIRouter{
		engine: NewRoutingEngine(config, opts...),
	}
}

// NewFromMap parses configuration map and returns an initialized AIRouter.
func NewFromMap(configMap any, customEnv ...map[string]string) (*AIRouter, error) {
	cfg, err := ParseConfig(configMap, customEnv...)
	if err != nil {
		return nil, err
	}
	return New(cfg), nil
}

// Complete executes a chat completion across configured routes with automatic fallbacks and retries.
func (r *AIRouter) Complete(ctx context.Context, req ChatRequest, opts ...CallOptions) (*ChatResponse, error) {
	return r.engine.Complete(ctx, &req, opts...)
}

// Stream initiates a real-time streaming response via channels.
func (r *AIRouter) Stream(ctx context.Context, req ChatRequest, opts ...CallOptions) (<-chan ChatChunk, <-chan error) {
	return r.engine.Stream(ctx, &req, opts...)
}

// Raw passes an arbitrary payload straight to a route's upstream provider endpoint.
func (r *AIRouter) Raw(ctx context.Context, req RawRequest) (*http.Response, error) {
	return r.engine.Raw(ctx, req)
}

// Embed generates embeddings for text inputs.
func (r *AIRouter) Embed(ctx context.Context, req EmbeddingRequest) (*EmbeddingResponse, error) {
	return r.engine.Embed(ctx, &req)
}

// Stats returns the real-time operational health snapshot of all configured routes.
func (r *AIRouter) Stats() map[string]RouteHealthSnapshot {
	return r.engine.Stats()
}
