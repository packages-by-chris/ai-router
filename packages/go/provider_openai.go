package airouter

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

// OpenAIAdapter implements ProviderAdapter for OpenAI and OpenAI-compatible endpoints.
type OpenAIAdapter struct {
	DefaultBaseURL string
	ProviderLabel  string
}

func NewOpenAIAdapter(label string) *OpenAIAdapter {
	baseURL := "https://api.openai.com/v1"
	if label != "openai" {
		baseURL = ""
	}
	return &OpenAIAdapter{
		DefaultBaseURL: baseURL,
		ProviderLabel:  label,
	}
}

func (a *OpenAIAdapter) TranslateRequest(req *ChatRequest, providerModel string, stream bool) (map[string]any, error) {
	wireMsgs := make([]map[string]any, len(req.Messages))
	for i, m := range req.Messages {
		msgMap := map[string]any{
			"role": m.Role,
		}
		if m.Content != nil {
			msgMap["content"] = m.Content
		}
		if m.Name != "" {
			msgMap["name"] = m.Name
		}
		if len(m.ToolCalls) > 0 {
			tcList := make([]map[string]any, len(m.ToolCalls))
			for j, tc := range m.ToolCalls {
				tcList[j] = map[string]any{
					"id":   tc.ID,
					"type": tc.Type,
					"function": map[string]any{
						"name":      tc.Function.Name,
						"arguments": tc.Function.Arguments,
					},
				}
			}
			msgMap["tool_calls"] = tcList
		}
		if m.ToolCallID != "" {
			msgMap["tool_call_id"] = m.ToolCallID
		}
		wireMsgs[i] = msgMap
	}

	body := map[string]any{
		"model":    providerModel,
		"messages": wireMsgs,
	}

	if len(req.Tools) > 0 {
		toolsList := make([]map[string]any, len(req.Tools))
		for i, t := range req.Tools {
			toolsList[i] = map[string]any{
				"type": t.Type,
				"function": map[string]any{
					"name":        t.Function.Name,
					"description": t.Function.Description,
					"parameters":  t.Function.Parameters,
				},
			}
		}
		body["tools"] = toolsList
	}
	if req.ToolChoice != nil {
		body["tool_choice"] = req.ToolChoice
	}
	if req.Temperature != nil {
		body["temperature"] = *req.Temperature
	}
	if req.TopP != nil {
		body["top_p"] = *req.TopP
	}
	if req.MaxTokens != nil {
		body["max_tokens"] = *req.MaxTokens
	}
	if req.Stop != nil {
		body["stop"] = req.Stop
	}
	if req.ResponseFormat != nil {
		rf := map[string]any{"type": req.ResponseFormat.Type}
		if req.ResponseFormat.JSONSchema != nil {
			jsMap := map[string]any{
				"schema": req.ResponseFormat.JSONSchema.Schema,
			}
			if req.ResponseFormat.JSONSchema.Name != "" {
				jsMap["name"] = req.ResponseFormat.JSONSchema.Name
			}
			if req.ResponseFormat.JSONSchema.Strict != nil {
				jsMap["strict"] = *req.ResponseFormat.JSONSchema.Strict
			}
			rf["json_schema"] = jsMap
		}
		body["response_format"] = rf
	}
	if req.ReasoningEffort != "" {
		body["reasoning_effort"] = req.ReasoningEffort
	}
	if req.User != "" {
		body["user"] = req.User
	}
	if stream {
		body["stream"] = true
		hasCustomStreamOptions := false
		if req.ProviderOptions != nil {
			if opt, ok := req.ProviderOptions["openai"]; ok {
				if _, hasSO := opt["stream_options"]; hasSO {
					hasCustomStreamOptions = true
				}
			}
		}
		if !hasCustomStreamOptions {
			body["stream_options"] = map[string]any{"include_usage": true}
		}
	}

	// Merge providerOptions["openai"]
	if req.ProviderOptions != nil {
		if opt, ok := req.ProviderOptions["openai"]; ok {
			for k, v := range opt {
				body[k] = v
			}
		}
	}
	if val, ok := body["stream_options"]; ok && val == nil {
		delete(body, "stream_options")
	}

	return body, nil
}

func parseOpenAIUsage(uMap map[string]any) *Usage {
	if uMap == nil {
		return nil
	}
	pt, _ := uMap["prompt_tokens"].(float64)
	ct, _ := uMap["completion_tokens"].(float64)
	tt, _ := uMap["total_tokens"].(float64)

	var cached *int
	if ptDetails, ok := uMap["prompt_tokens_details"].(map[string]any); ok {
		if cVal, ok := ptDetails["cached_tokens"].(float64); ok {
			cInt := int(cVal)
			cached = &cInt
		}
	}
	var reasoning *int
	if ctDetails, ok := uMap["completion_tokens_details"].(map[string]any); ok {
		if rVal, ok := ctDetails["reasoning_tokens"].(float64); ok {
			rInt := int(rVal)
			reasoning = &rInt
		}
	}

	return &Usage{
		PromptTokens:     int(pt),
		CompletionTokens: int(ct),
		TotalTokens:      int(tt),
		CachedTokens:     cached,
		ReasoningTokens:  reasoning,
	}
}

func (a *OpenAIAdapter) TranslateResponse(body []byte, providerModel string) (*ChatResponse, error) {
	var j map[string]any
	if err := json.Unmarshal(body, &j); err != nil {
		return nil, err
	}

	id, _ := j["id"].(string)
	model, _ := j["model"].(string)
	if model == "" {
		model = providerModel
	}
	createdVal, _ := j["created"].(float64)

	var choices []Choice
	if rawChoices, ok := j["choices"].([]any); ok {
		for i, cVal := range rawChoices {
			cMap, ok := cVal.(map[string]any)
			if !ok {
				continue
			}
			var finishReason *string
			if fr, ok := cMap["finish_reason"].(string); ok {
				finishReason = &fr
			}
			msgMap, _ := cMap["message"].(map[string]any)
			role, _ := msgMap["role"].(string)
			if role == "" {
				role = RoleAssistant
			}
			name, _ := msgMap["name"].(string)
			content := msgMap["content"]

			var toolCalls []ToolCall
			if rawTCs, ok := msgMap["tool_calls"].([]any); ok {
				for _, tcVal := range rawTCs {
					if tcMap, ok := tcVal.(map[string]any); ok {
						fnMap, _ := tcMap["function"].(map[string]any)
						fnName, _ := fnMap["name"].(string)
						fnArgs, _ := fnMap["arguments"].(string)
						tcID, _ := tcMap["id"].(string)
						tcType, _ := tcMap["type"].(string)
						if tcType == "" {
							tcType = "function"
						}
						toolCalls = append(toolCalls, ToolCall{
							ID:   tcID,
							Type: tcType,
							Function: ToolCallFunction{
								Name:      fnName,
								Arguments: fnArgs,
							},
						})
					}
				}
			}

			idx := i
			if idxNum, ok := cMap["index"].(float64); ok {
				idx = int(idxNum)
			}

			choices = append(choices, Choice{
				Index: idx,
				Message: ChatMessage{
					Role:      role,
					Content:   content,
					Name:      name,
					ToolCalls: toolCalls,
				},
				FinishReason: finishReason,
			})
		}
	}

	var usage *Usage
	if uMap, ok := j["usage"].(map[string]any); ok {
		usage = parseOpenAIUsage(uMap)
	}

	label := a.ProviderLabel
	if label == "" {
		label = "openai"
	}

	return &ChatResponse{
		ID:       id,
		Model:    model,
		Provider: label,
		Created:  int64(createdVal),
		Choices:  choices,
		Usage:    usage,
	}, nil
}

func (a *OpenAIAdapter) TranslateChunk(chunkJSON []byte, providerModel string) (*ChatChunk, error) {
	var j map[string]any
	if err := json.Unmarshal(chunkJSON, &j); err != nil {
		return nil, err
	}

	id, _ := j["id"].(string)
	model, _ := j["model"].(string)
	if model == "" {
		model = providerModel
	}

	rawChoices, ok := j["choices"].([]any)
	var usage *Usage
	if uMap, ok := j["usage"].(map[string]any); ok {
		usage = parseOpenAIUsage(uMap)
	}

	// Terminal chunk or keep-alive with no choices and no usage yields nil
	if (!ok || len(rawChoices) == 0) && usage == nil {
		return nil, nil
	}

	var delta Delta
	var finishReason *string

	if ok && len(rawChoices) > 0 {
		if first, ok := rawChoices[0].(map[string]any); ok {
			if fr, ok := first["finish_reason"].(string); ok {
				finishReason = &fr
			}
			if dMap, ok := first["delta"].(map[string]any); ok {
				if r, ok := dMap["role"].(string); ok {
					delta.Role = &r
				}
				if c, ok := dMap["content"].(string); ok {
					delta.Content = &c
				}
				// Support reasoning and reasoning_content
				if r, ok := dMap["reasoning"].(string); ok {
					delta.Reasoning = &r
				} else if r, ok := dMap["reasoning_content"].(string); ok {
					delta.Reasoning = &r
				}
				if rawTCs, ok := dMap["tool_calls"].([]any); ok {
					for _, tcVal := range rawTCs {
						if tcMap, ok := tcVal.(map[string]any); ok {
							idx := 0
							if idxNum, ok := tcMap["index"].(float64); ok {
								idx = int(idxNum)
							}
							var tcID *string
							if idStr, ok := tcMap["id"].(string); ok {
								tcID = &idStr
							}
							var tcType *string
							if typeStr, ok := tcMap["type"].(string); ok {
								tcType = &typeStr
							}
							var fnDelta *ToolCallDeltaFunction
							if fnMap, ok := tcMap["function"].(map[string]any); ok {
								var fnName *string
								if nameStr, ok := fnMap["name"].(string); ok {
									fnName = &nameStr
								}
								var fnArgs *string
								if argsStr, ok := fnMap["arguments"].(string); ok {
									fnArgs = &argsStr
								}
								fnDelta = &ToolCallDeltaFunction{
									Name:      fnName,
									Arguments: fnArgs,
								}
							}
							delta.ToolCalls = append(delta.ToolCalls, ToolCallDelta{
								Index:    idx,
								ID:       tcID,
								Type:     tcType,
								Function: fnDelta,
							})
						}
					}
				}
			}
		}
	}

	label := a.ProviderLabel
	if label == "" {
		label = "openai"
	}

	return &ChatChunk{
		ID:           id,
		Model:        model,
		Provider:     label,
		Delta:        delta,
		FinishReason: finishReason,
		Usage:        usage,
	}, nil
}

func (a *OpenAIAdapter) Execute(ctx context.Context, route *NormalizedRoute, apiKey string, req *ChatRequest, client *http.Client) (*ChatResponse, error) {
	bodyMap, err := a.TranslateRequest(req, route.Model, false)
	if err != nil {
		return nil, err
	}
	bodyBytes, err := json.Marshal(bodyMap)
	if err != nil {
		return nil, err
	}

	baseURL := route.BaseURL
	if baseURL == "" {
		baseURL = a.DefaultBaseURL
	}
	url := strings.TrimRight(baseURL, "/") + "/chat/completions"

	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		authHeader := route.AuthHeaderName
		if authHeader == "" {
			authHeader = "Authorization"
			httpReq.Header.Set(authHeader, "Bearer "+apiKey)
		} else {
			httpReq.Header.Set(authHeader, apiKey)
		}
	}
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

	label := route.Provider
	if route.Provider == "openai-compatible" {
		label = route.ID
	}
	if err := RequireOK(resp, label, respBytes); err != nil {
		return nil, err
	}

	chatResp, err := a.TranslateResponse(respBytes, route.Model)
	if err != nil {
		return nil, err
	}
	chatResp.Provider = label
	return chatResp, nil
}

func (a *OpenAIAdapter) ExecuteStream(ctx context.Context, route *NormalizedRoute, apiKey string, req *ChatRequest, client *http.Client) (<-chan ChatChunk, <-chan error, error) {
	bodyMap, err := a.TranslateRequest(req, route.Model, true)
	if err != nil {
		return nil, nil, err
	}
	bodyBytes, err := json.Marshal(bodyMap)
	if err != nil {
		return nil, nil, err
	}

	baseURL := route.BaseURL
	if baseURL == "" {
		baseURL = a.DefaultBaseURL
	}
	url := strings.TrimRight(baseURL, "/") + "/chat/completions"

	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	if apiKey != "" {
		authHeader := route.AuthHeaderName
		if authHeader == "" {
			authHeader = "Authorization"
			httpReq.Header.Set(authHeader, "Bearer "+apiKey)
		} else {
			httpReq.Header.Set(authHeader, apiKey)
		}
	}
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

	label := route.Provider
	if route.Provider == "openai-compatible" {
		label = route.ID
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		respBytes, _ := io.ReadAll(resp.Body)
		return nil, nil, RequireOK(resp, label, respBytes)
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
				chunk.Provider = label
				chunkChan <- *chunk
			}
		}
	}()

	return chunkChan, errChan, nil
}

func (a *OpenAIAdapter) ExecuteRaw(ctx context.Context, route *NormalizedRoute, apiKey string, opts RawRequestOptions, client *http.Client) (*http.Response, error) {
	baseURL := route.BaseURL
	if baseURL == "" {
		baseURL = a.DefaultBaseURL
	}
	path := opts.Path
	if path == "" {
		path = "/chat/completions"
	}
	url := strings.TrimRight(baseURL, "/") + "/" + strings.TrimLeft(path, "/")

	bodyBytes, err := json.Marshal(opts.Body)
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	}
	for k, v := range opts.Headers {
		httpReq.Header.Set(k, v)
	}

	if client == nil {
		client = http.DefaultClient
	}
	return client.Do(httpReq)
}

func (a *OpenAIAdapter) Embed(ctx context.Context, route *NormalizedRoute, apiKey string, req *EmbeddingRequest, client *http.Client) (*EmbeddingResponse, error) {
	baseURL := route.BaseURL
	if baseURL == "" {
		baseURL = a.DefaultBaseURL
	}
	url := strings.TrimRight(baseURL, "/") + "/embeddings"

	bodyMap := map[string]any{
		"model": route.Model,
		"input": req.Input,
	}
	bodyBytes, err := json.Marshal(bodyMap)
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+apiKey)
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

	label := route.Provider
	if err := RequireOK(resp, label, respBytes); err != nil {
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
		Provider: label,
		Data:     embData,
		Usage:    usage,
	}, nil
}
