package airouter

import (
	"context"
	"net/http"
	"time"
)

// NormalizedRoute has all presets and defaults resolved.
type NormalizedRoute struct {
	ID                  string
	Provider            string
	Model               string
	APIKeys             []string
	BaseURL             string
	APIVersion          string
	Region              string
	Project             string
	Headers             map[string]string
	MaxRetries          int
	TimeoutMs           int
	StreamIdleTimeoutMs int
	Limit               *LimitRule
	Budget              *BudgetRule
	Weight              int
	Capabilities        *Capabilities
	Pricing             *TokenPrice

	AdapterID      string
	AuthHeaderName string
}

// RawRequestOptions specifies parameters for raw provider execution.
type RawRequestOptions struct {
	Path    string
	Body    any
	Headers map[string]string
}

// ProviderAdapter handles translating and executing requests for a specific provider wire format.
type ProviderAdapter interface {
	TranslateRequest(req *ChatRequest, providerModel string, stream bool) (map[string]any, error)
	TranslateResponse(body []byte, providerModel string) (*ChatResponse, error)
	TranslateChunk(chunkJSON []byte, providerModel string) (*ChatChunk, error)
	Execute(ctx context.Context, route *NormalizedRoute, apiKey string, req *ChatRequest, client *http.Client) (*ChatResponse, error)
	ExecuteStream(ctx context.Context, route *NormalizedRoute, apiKey string, req *ChatRequest, client *http.Client) (<-chan ChatChunk, <-chan error, error)
	ExecuteRaw(ctx context.Context, route *NormalizedRoute, apiKey string, opts RawRequestOptions, client *http.Client) (*http.Response, error)
	Embed(ctx context.Context, route *NormalizedRoute, apiKey string, req *EmbeddingRequest, client *http.Client) (*EmbeddingResponse, error)
}

// NormalizeRoute applies presets, default URLs, and key pools to a ModelRoute.
func NormalizeRoute(r *ModelRoute) *NormalizedRoute {
	nr := &NormalizedRoute{
		ID:                  r.ID,
		Provider:            r.Provider,
		Model:               r.Model,
		BaseURL:             r.BaseURL,
		APIVersion:          r.APIVersion,
		Region:              r.Region,
		Project:             r.Project,
		Headers:             make(map[string]string),
		MaxRetries:          2,
		TimeoutMs:           30000,
		StreamIdleTimeoutMs: 15000,
		Limit:               r.Limit,
		Budget:              r.Budget,
		Capabilities:        r.Capabilities,
		Pricing:             r.Pricing,
		AdapterID:           r.Provider,
	}

	for k, v := range r.Headers {
		nr.Headers[k] = v
	}

	if r.MaxRetries != nil {
		nr.MaxRetries = *r.MaxRetries
	}
	if r.TimeoutMs != nil {
		nr.TimeoutMs = *r.TimeoutMs
	}
	if r.StreamIdleTimeoutMs != nil {
		nr.StreamIdleTimeoutMs = *r.StreamIdleTimeoutMs
	}
	if r.Weight != nil {
		nr.Weight = *r.Weight
	} else {
		nr.Weight = 1
	}

	// Key pool
	if len(r.APIKeys) > 0 {
		nr.APIKeys = append([]string{}, r.APIKeys...)
	} else if r.APIKey != "" {
		nr.APIKeys = []string{r.APIKey}
	} else {
		nr.APIKeys = []string{""}
	}

	// Apply presets
	if preset, ok := Presets[r.Provider]; ok {
		nr.AdapterID = preset.Adapter
		if nr.BaseURL == "" {
			nr.BaseURL = preset.BaseURL
		}
		if preset.AuthHeader != "" {
			nr.AuthHeaderName = preset.AuthHeader
		}
	}

	return nr
}

// RequireOK validates the HTTP response status.
func RequireOK(resp *http.Response, provider string, body []byte) error {
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	kind := ClassifyStatus(resp.StatusCode)
	retryAfter := 0
	if val := resp.Header.Get("Retry-After"); val != "" {
		// Could parse seconds or date
		if d, err := time.ParseDuration(val + "s"); err == nil {
			retryAfter = int(d.Milliseconds())
		}
	}
	return &ProviderError{
		Provider:     provider,
		Kind:         kind,
		Status:       resp.StatusCode,
		Message:      string(body),
		RetryAfterMs: retryAfter,
	}
}
