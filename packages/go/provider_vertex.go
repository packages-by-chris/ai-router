package airouter

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// VertexAdapter implements ProviderAdapter for Google Cloud Vertex AI.
type VertexAdapter struct {
	gemini *GeminiAdapter
}

func NewVertexAdapter() *VertexAdapter {
	return &VertexAdapter{
		gemini: NewGeminiAdapter(),
	}
}

func (a *VertexAdapter) vertexBaseURL(route *NormalizedRoute) (string, error) {
	if route.BaseURL != "" {
		return strings.TrimRight(route.BaseURL, "/"), nil
	}
	if route.Region == "" {
		return "", &ConfigError{Message: fmt.Sprintf("route %q: vertex provider requires region", route.ID)}
	}
	return fmt.Sprintf("https://%s-aiplatform.googleapis.com/v1", route.Region), nil
}

func (a *VertexAdapter) modelEndpoint(route *NormalizedRoute, action string) (string, error) {
	if route.Project == "" {
		return "", &ConfigError{Message: fmt.Sprintf("route %q: vertex provider requires project", route.ID)}
	}
	if route.Region == "" {
		return "", &ConfigError{Message: fmt.Sprintf("route %q: vertex provider requires region", route.ID)}
	}
	baseURL, err := a.vertexBaseURL(route)
	if err != nil {
		return "", err
	}
	project := url.PathEscape(route.Project)
	region := url.PathEscape(route.Region)
	model := url.PathEscape(route.Model)
	return fmt.Sprintf("%s/projects/%s/locations/%s/publishers/google/models/%s:%s", baseURL, project, region, model, action), nil
}

func (a *VertexAdapter) TranslateRequest(req *ChatRequest, providerModel string, stream bool) (map[string]any, error) {
	return a.gemini.TranslateRequest(req, providerModel, stream)
}

func (a *VertexAdapter) TranslateResponse(body []byte, providerModel string) (*ChatResponse, error) {
	resp, err := a.gemini.TranslateResponse(body, providerModel)
	if err != nil {
		return nil, err
	}
	resp.Provider = "vertex"
	return resp, nil
}

func (a *VertexAdapter) TranslateChunk(chunkJSON []byte, providerModel string) (*ChatChunk, error) {
	return nil, nil
}

func (a *VertexAdapter) Execute(ctx context.Context, route *NormalizedRoute, apiKey string, req *ChatRequest, client *http.Client) (*ChatResponse, error) {
	reqURL, err := a.modelEndpoint(route, "generateContent")
	if err != nil {
		return nil, err
	}

	bodyMap, err := a.TranslateRequest(req, route.Model, false)
	if err != nil {
		return nil, err
	}
	bodyBytes, err := json.Marshal(bodyMap)
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", reqURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	for k, v := range route.Headers {
		httpReq.Header.Set(k, v)
	}

	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if err := RequireOK(resp, "vertex", respBytes); err != nil {
		return nil, err
	}

	return a.TranslateResponse(respBytes, route.Model)
}

func (a *VertexAdapter) ExecuteStream(ctx context.Context, route *NormalizedRoute, apiKey string, req *ChatRequest, client *http.Client) (<-chan ChatChunk, <-chan error, error) {
	reqURL, err := a.modelEndpoint(route, "streamGenerateContent?alt=sse")
	if err != nil {
		return nil, nil, err
	}

	bodyMap, err := a.TranslateRequest(req, route.Model, true)
	if err != nil {
		return nil, nil, err
	}
	bodyBytes, err := json.Marshal(bodyMap)
	if err != nil {
		return nil, nil, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", reqURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	for k, v := range route.Headers {
		httpReq.Header.Set(k, v)
	}

	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, nil, err
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		respBytes, _ := io.ReadAll(resp.Body)
		return nil, nil, RequireOK(resp, "vertex", respBytes)
	}

	chunkChan := make(chan ChatChunk, 50)
	errChan := make(chan error, 1)

	go func() {
		defer resp.Body.Close()
		defer close(chunkChan)
		defer close(errChan)

		sentRole := false
		ssePayloads := ParseSSE(resp.Body)

		for payload := range ssePayloads {
			var ev map[string]any
			if err := json.Unmarshal([]byte(payload), &ev); err != nil {
				continue
			}

			if !sentRole {
				sentRole = true
				role := RoleAssistant
				chunkChan <- ChatChunk{
					ID:       "",
					Model:    route.Model,
					Provider: "vertex",
					Delta:    Delta{Role: &role},
				}
			}

			var usage *Usage
			if uMap, ok := ev["usageMetadata"].(map[string]any); ok {
				usage = parseGeminiUsage(uMap)
			}

			if candidates, ok := ev["candidates"].([]any); ok && len(candidates) > 0 {
				if cand, ok := candidates[0].(map[string]any); ok {
					finishReason := mapGeminiFinishReason(cand["finishReason"])
					if content, ok := cand["content"].(map[string]any); ok {
						if parts, ok := content["parts"].([]any); ok {
							for _, pVal := range parts {
								if pMap, ok := pVal.(map[string]any); ok {
									if t, ok := pMap["text"].(string); ok && t != "" {
										chunkChan <- ChatChunk{
											ID:       "",
											Model:    route.Model,
											Provider: "vertex",
											Delta:    Delta{Content: &t},
										}
									}
								}
							}
						}
					}
					if finishReason != nil || usage != nil {
						chunkChan <- ChatChunk{
							ID:           "",
							Model:        route.Model,
							Provider:     "vertex",
							Delta:        Delta{},
							FinishReason: finishReason,
							Usage:        usage,
						}
					}
				}
			}
		}
	}()

	return chunkChan, errChan, nil
}

func (a *VertexAdapter) ExecuteRaw(ctx context.Context, route *NormalizedRoute, apiKey string, opts RawRequestOptions, client *http.Client) (*http.Response, error) {
	defaultURL, err := a.modelEndpoint(route, "generateContent")
	if err != nil {
		return nil, err
	}
	reqURL := defaultURL
	if opts.Path != "" {
		base, err := a.vertexBaseURL(route)
		if err != nil {
			return nil, err
		}
		reqURL = base + opts.Path
	}

	bodyBytes, err := json.Marshal(opts.Body)
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", reqURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	for k, v := range opts.Headers {
		httpReq.Header.Set(k, v)
	}

	if client == nil {
		client = http.DefaultClient
	}
	return client.Do(httpReq)
}

func (a *VertexAdapter) Embed(ctx context.Context, route *NormalizedRoute, apiKey string, req *EmbeddingRequest, client *http.Client) (*EmbeddingResponse, error) {
	return nil, fmt.Errorf("vertex embeddings require custom publisher endpoint")
}
