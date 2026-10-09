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

// AzureAdapter implements ProviderAdapter for Azure OpenAI.
type AzureAdapter struct {
	openAI *OpenAIAdapter
}

func NewAzureAdapter() *AzureAdapter {
	return &AzureAdapter{
		openAI: NewOpenAIAdapter("azure"),
	}
}

func (a *AzureAdapter) TranslateRequest(req *ChatRequest, providerModel string, stream bool) (map[string]any, error) {
	return a.openAI.TranslateRequest(req, providerModel, stream)
}

func (a *AzureAdapter) TranslateResponse(body []byte, providerModel string) (*ChatResponse, error) {
	resp, err := a.openAI.TranslateResponse(body, providerModel)
	if err != nil {
		return nil, err
	}
	resp.Provider = "azure"
	return resp, nil
}

func (a *AzureAdapter) TranslateChunk(chunkJSON []byte, providerModel string) (*ChatChunk, error) {
	chunk, err := a.openAI.TranslateChunk(chunkJSON, providerModel)
	if err != nil {
		return nil, err
	}
	if chunk != nil {
		chunk.Provider = "azure"
	}
	return chunk, nil
}

func (a *AzureAdapter) endpoint(route *NormalizedRoute, action string) (string, error) {
	if route.BaseURL == "" {
		return "", &ConfigError{Message: fmt.Sprintf("route %q: azure provider requires baseUrl", route.ID)}
	}
	apiVersion := route.APIVersion
	if apiVersion == "" {
		apiVersion = "2024-10-21"
	}
	baseURL := strings.TrimRight(route.BaseURL, "/")
	return fmt.Sprintf("%s/openai/deployments/%s/%s?api-version=%s", baseURL, url.PathEscape(route.Model), action, url.QueryEscape(apiVersion)), nil
}

func (a *AzureAdapter) Execute(ctx context.Context, route *NormalizedRoute, apiKey string, req *ChatRequest, client *http.Client) (*ChatResponse, error) {
	bodyMap, err := a.TranslateRequest(req, route.Model, false)
	if err != nil {
		return nil, err
	}
	bodyBytes, err := json.Marshal(bodyMap)
	if err != nil {
		return nil, err
	}

	reqURL, err := a.endpoint(route, "chat/completions")
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", reqURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("api-key", apiKey)
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

	if err := RequireOK(resp, "azure", respBytes); err != nil {
		return nil, err
	}

	return a.TranslateResponse(respBytes, route.Model)
}

func (a *AzureAdapter) ExecuteStream(ctx context.Context, route *NormalizedRoute, apiKey string, req *ChatRequest, client *http.Client) (<-chan ChatChunk, <-chan error, error) {
	bodyMap, err := a.TranslateRequest(req, route.Model, true)
	if err != nil {
		return nil, nil, err
	}
	bodyBytes, err := json.Marshal(bodyMap)
	if err != nil {
		return nil, nil, err
	}

	reqURL, err := a.endpoint(route, "chat/completions")
	if err != nil {
		return nil, nil, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", reqURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	httpReq.Header.Set("api-key", apiKey)
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
		return nil, nil, RequireOK(resp, "azure", respBytes)
	}

	chunkChan := make(chan ChatChunk, 50)
	errChan := make(chan error, 1)

	go func() {
		defer resp.Body.Close()
		defer close(chunkChan)
		defer close(errChan)

		ssePayloads := ParseSSE(resp.Body)
		for payload := range ssePayloads {
			if strings.TrimSpace(payload) == "[DONE]" {
				break
			}
			chunk, err := a.TranslateChunk([]byte(payload), route.Model)
			if err != nil {
				errChan <- err
				return
			}
			if chunk != nil {
				chunk.Provider = "azure"
				chunkChan <- *chunk
			}
		}
	}()

	return chunkChan, errChan, nil
}

func (a *AzureAdapter) ExecuteRaw(ctx context.Context, route *NormalizedRoute, apiKey string, opts RawRequestOptions, client *http.Client) (*http.Response, error) {
	reqURL, err := a.endpoint(route, "chat/completions")
	if err != nil {
		return nil, err
	}
	if opts.Path != "" {
		apiVersion := route.APIVersion
		if apiVersion == "" {
			apiVersion = "2024-10-21"
		}
		sep := "?"
		if strings.Contains(opts.Path, "?") {
			sep = "&"
		}
		baseURL := strings.TrimRight(route.BaseURL, "/")
		reqURL = fmt.Sprintf("%s%s%sapi-version=%s", baseURL, opts.Path, sep, url.QueryEscape(apiVersion))
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
	httpReq.Header.Set("api-key", apiKey)
	for k, v := range opts.Headers {
		httpReq.Header.Set(k, v)
	}

	if client == nil {
		client = http.DefaultClient
	}
	return client.Do(httpReq)
}

func (a *AzureAdapter) Embed(ctx context.Context, route *NormalizedRoute, apiKey string, req *EmbeddingRequest, client *http.Client) (*EmbeddingResponse, error) {
	reqURL, err := a.endpoint(route, "embeddings")
	if err != nil {
		return nil, err
	}

	bodyMap := map[string]any{
		"model": route.Model,
		"input": req.Input,
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
	httpReq.Header.Set("api-key", apiKey)

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

	if err := RequireOK(resp, "azure", respBytes); err != nil {
		return nil, err
	}

	var j map[string]any
	if err := json.Unmarshal(respBytes, &j); err != nil {
		return nil, err
	}

	var embData []EmbeddingData
	if rawData, ok := j["data"].([]any); ok {
		for i, item := range rawData {
			if itemMap, ok := item.(map[string]any); ok {
				idx := i
				if idxNum, ok := itemMap["index"].(float64); ok {
					idx = int(idxNum)
				}
				var vec []float64
				if rawVec, ok := itemMap["embedding"].([]any); ok {
					for _, num := range rawVec {
						if f, ok := num.(float64); ok {
							vec = append(vec, f)
						}
					}
				}
				embData = append(embData, EmbeddingData{
					Index:     idx,
					Embedding: vec,
				})
			}
		}
	}

	var usage *Usage
	if uMap, ok := j["usage"].(map[string]any); ok {
		usage = parseOpenAIUsage(uMap)
	}

	return &EmbeddingResponse{
		Object:   "list",
		Model:    route.Model,
		Provider: "azure",
		Data:     embData,
		Usage:    usage,
	}, nil
}
