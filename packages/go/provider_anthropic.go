package airouter

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
)

// AnthropicAdapter implements ProviderAdapter for Anthropic Claude.
type AnthropicAdapter struct {
	DefaultBaseURL string
}

func NewAnthropicAdapter() *AnthropicAdapter {
	return &AnthropicAdapter{
		DefaultBaseURL: "https://api.anthropic.com/v1",
	}
}

type anthropicTurn struct {
	role   string
	blocks []map[string]any
}

func parseImageBlock(url string) map[string]any {
	dataURIPattern := regexp.MustCompile(`(?i)^data:([^;,]+);base64,(.*)$`)
	if matches := dataURIPattern.FindStringSubmatch(url); len(matches) == 3 {
		return map[string]any{
			"type": "image",
			"source": map[string]any{
				"type":       "base64",
				"media_type": matches[1],
				"data":       matches[2],
			},
		}
	}
	if strings.HasPrefix(strings.ToLower(url), "http://") || strings.HasPrefix(strings.ToLower(url), "https://") {
		return map[string]any{
			"type": "image",
			"source": map[string]any{
				"type": "url",
				"url":  url,
			},
		}
	}
	return nil
}

func (a *AnthropicAdapter) TranslateRequest(req *ChatRequest, providerModel string, stream bool) (map[string]any, error) {
	var systemBlocks []map[string]any
	systemHasCacheMarker := false
	var turns []anthropicTurn

	push := func(role string, block map[string]any) {
		if len(turns) > 0 && turns[len(turns)-1].role == role {
			turns[len(turns)-1].blocks = append(turns[len(turns)-1].blocks, block)
		} else {
			turns = append(turns, anthropicTurn{role: role, blocks: []map[string]any{block}})
		}
	}

	for _, msg := range req.Messages {
		wantsCache := false
		if msg.ProviderOptions != nil {
			if opt, ok := msg.ProviderOptions["anthropic"]; ok {
				if cc, ok := opt["cache_control"].(bool); ok && cc {
					wantsCache = true
				}
			}
		}

		if msg.Role == RoleSystem {
			if wantsCache {
				systemHasCacheMarker = true
			}
			if str, ok := msg.Content.(string); ok && str != "" {
				blk := map[string]any{"type": "text", "text": str}
				if wantsCache {
					blk["cache_control"] = map[string]any{"type": "ephemeral"}
				}
				systemBlocks = append(systemBlocks, blk)
			} else if list, ok := msg.Content.([]any); ok {
				for i, p := range list {
					text := ""
					if cp, ok := p.(ContentPart); ok && cp.Type == "text" {
						text = cp.Text
					} else if pMap, ok := p.(map[string]any); ok && pMap["type"] == "text" {
						if t, ok := pMap["text"].(string); ok {
							text = t
						}
					}
					if text != "" {
						blk := map[string]any{"type": "text", "text": text}
						if wantsCache && i == len(list)-1 {
							blk["cache_control"] = map[string]any{"type": "ephemeral"}
						}
						systemBlocks = append(systemBlocks, blk)
					}
				}
			}
			continue
		}

		if msg.Role == RoleTool {
			resultText := ""
			if str, ok := msg.Content.(string); ok {
				resultText = str
			} else if list, ok := msg.Content.([]any); ok {
				var texts []string
				for _, p := range list {
					if cp, ok := p.(ContentPart); ok && cp.Type == "text" && cp.Text != "" {
						texts = append(texts, cp.Text)
					} else if pMap, ok := p.(map[string]any); ok && pMap["type"] == "text" {
						if t, ok := pMap["text"].(string); ok && t != "" {
							texts = append(texts, t)
						}
					}
				}
				resultText = strings.Join(texts, "\n")
			}
			push("user", map[string]any{
				"type":        "tool_result",
				"tool_use_id": msg.ToolCallID,
				"content":     resultText,
			})
			continue
		}

		role := "user"
		if msg.Role == RoleAssistant {
			role = "assistant"
		}
		var local []map[string]any

		if str, ok := msg.Content.(string); ok && str != "" {
			local = append(local, map[string]any{"type": "text", "text": str})
		} else if list, ok := msg.Content.([]any); ok {
			for _, p := range list {
				if cp, ok := p.(ContentPart); ok {
					if cp.Type == "text" && cp.Text != "" {
						local = append(local, map[string]any{"type": "text", "text": cp.Text})
					} else if cp.Type == "image_url" && cp.ImageURL != nil {
						if ib := parseImageBlock(cp.ImageURL.URL); ib != nil {
							local = append(local, ib)
						}
					}
				} else if pMap, ok := p.(map[string]any); ok {
					if pMap["type"] == "text" {
						if t, ok := pMap["text"].(string); ok && t != "" {
							local = append(local, map[string]any{"type": "text", "text": t})
						}
					} else if pMap["type"] == "image_url" {
						if img, ok := pMap["image_url"].(map[string]any); ok {
							if u, ok := img["url"].(string); ok {
								if ib := parseImageBlock(u); ib != nil {
									local = append(local, ib)
								}
							}
						}
					}
				}
			}
		}

		for _, tc := range msg.ToolCalls {
			var input any = map[string]any{}
			if tc.Function.Arguments != "" {
				_ = json.Unmarshal([]byte(tc.Function.Arguments), &input)
			}
			local = append(local, map[string]any{
				"type":  "tool_use",
				"id":    tc.ID,
				"name":  tc.Function.Name,
				"input": input,
			})
		}

		if wantsCache && len(local) > 0 {
			local[len(local)-1]["cache_control"] = map[string]any{"type": "ephemeral"}
		}

		if len(local) > 0 {
			if len(turns) > 0 && turns[len(turns)-1].role == role {
				turns[len(turns)-1].blocks = append(turns[len(turns)-1].blocks, local...)
			} else {
				turns = append(turns, anthropicTurn{role: role, blocks: local})
			}
		}
	}

	maxTokens := 4096
	if req.MaxTokens != nil {
		maxTokens = *req.MaxTokens
	}

	messages := make([]map[string]any, len(turns))
	for i, t := range turns {
		messages[i] = map[string]any{"role": t.role, "content": t.blocks}
	}

	body := map[string]any{
		"model":      providerModel,
		"max_tokens": maxTokens,
		"messages":   messages,
	}

	if len(systemBlocks) > 0 {
		if systemHasCacheMarker {
			body["system"] = systemBlocks
		} else {
			var texts []string
			for _, sb := range systemBlocks {
				if t, ok := sb["text"].(string); ok {
					texts = append(texts, t)
				}
			}
			body["system"] = strings.Join(texts, "\n\n")
		}
	}

	if req.Temperature != nil {
		body["temperature"] = *req.Temperature
	}
	if req.TopP != nil {
		body["top_p"] = *req.TopP
	}
	if req.Stop != nil {
		if list, ok := req.Stop.([]string); ok {
			body["stop_sequences"] = list
		} else if list, ok := req.Stop.([]any); ok {
			body["stop_sequences"] = list
		} else if str, ok := req.Stop.(string); ok {
			body["stop_sequences"] = []string{str}
		}
	}

	sendTools := req.ToolChoice != "none" && len(req.Tools) > 0
	if sendTools {
		toolsList := make([]map[string]any, len(req.Tools))
		for i, t := range req.Tools {
			toolsList[i] = map[string]any{
				"name":         t.Function.Name,
				"input_schema": t.Function.Parameters,
			}
			if t.Function.Description != "" {
				toolsList[i]["description"] = t.Function.Description
			}
		}
		body["tools"] = toolsList

		if choice, ok := req.ToolChoice.(string); ok {
			if choice == "auto" {
				body["tool_choice"] = map[string]any{"type": "auto"}
			} else if choice == "required" {
				body["tool_choice"] = map[string]any{"type": "any"}
			}
		} else if choiceMap, ok := req.ToolChoice.(map[string]any); ok {
			if fn, ok := choiceMap["function"].(map[string]any); ok {
				if name, ok := fn["name"].(string); ok {
					body["tool_choice"] = map[string]any{
						"type": "tool",
						"name": name,
					}
				}
			}
		}
	}

	if req.ReasoningEffort != "" {
		budgets := map[string]int{"low": 4096, "medium": 12288, "high": 24576}
		budget := budgets[req.ReasoningEffort]
		if budget == 0 {
			budget = 4096
		}
		body["thinking"] = map[string]any{"type": "enabled", "budget_tokens": budget}
		delete(body, "temperature")
		delete(body, "top_p")
		if maxTokens <= budget {
			body["max_tokens"] = budget + 1024
		}
		if tc, ok := body["tool_choice"].(map[string]any); ok {
			if tc["type"] != "auto" {
				delete(body, "tool_choice")
			}
		}
	}

	if stream {
		body["stream"] = true
	}

	if req.ProviderOptions != nil {
		if extra, ok := req.ProviderOptions["anthropic"]; ok {
			for k, v := range extra {
				body[k] = v
			}
		}
	}

	return body, nil
}

func parseAnthropicUsage(uMap map[string]any) *Usage {
	if uMap == nil {
		return nil
	}
	inTok, _ := uMap["input_tokens"].(float64)
	outTok, _ := uMap["output_tokens"].(float64)
	cacheRead, _ := uMap["cache_read_input_tokens"].(float64)
	cacheWrite, _ := uMap["cache_creation_input_tokens"].(float64)

	var cr *int
	if cacheRead > 0 {
		crVal := int(cacheRead)
		cr = &crVal
	}
	var cw *int
	if cacheWrite > 0 {
		cwVal := int(cacheWrite)
		cw = &cwVal
	}

	tot := int(inTok) + int(outTok) + int(cacheRead) + int(cacheWrite)
	return &Usage{
		PromptTokens:     int(inTok),
		CompletionTokens: int(outTok),
		TotalTokens:      tot,
		CachedTokens:     cr,
		CacheWriteTokens: cw,
	}
}

func mapAnthropicFinishReason(stopReason any) *string {
	if stopReason == nil {
		return nil
	}
	sr, ok := stopReason.(string)
	if !ok {
		return nil
	}
	var res string
	switch sr {
	case "end_turn", "stop_sequence", "pause_turn":
		res = "stop"
	case "max_tokens":
		res = "length"
	case "tool_use":
		res = "tool_calls"
	case "refusal":
		res = "content_filter"
	default:
		res = sr
	}
	return &res
}

func (a *AnthropicAdapter) TranslateResponse(body []byte, providerModel string) (*ChatResponse, error) {
	var j map[string]any
	if err := json.Unmarshal(body, &j); err != nil {
		return nil, err
	}

	id, _ := j["id"].(string)
	model, _ := j["model"].(string)
	if model == "" {
		model = providerModel
	}

	var text string
	var reasoning string
	var toolCalls []ToolCall

	if blocks, ok := j["content"].([]any); ok {
		for _, bVal := range blocks {
			if bMap, ok := bVal.(map[string]any); ok {
				bType, _ := bMap["type"].(string)
				switch bType {
				case "text":
					if t, ok := bMap["text"].(string); ok {
						text += t
					}
				case "thinking":
					if th, ok := bMap["thinking"].(string); ok {
						reasoning += th
					}
				case "tool_use":
					tcID, _ := bMap["id"].(string)
					tcName, _ := bMap["name"].(string)
					argsBytes, _ := json.Marshal(bMap["input"])
					toolCalls = append(toolCalls, ToolCall{
						ID:   tcID,
						Type: "function",
						Function: ToolCallFunction{
							Name:      tcName,
							Arguments: string(argsBytes),
						},
					})
				}
			}
		}
	}

	var msgContent any
	if text != "" {
		msgContent = text
	} else if len(toolCalls) == 0 {
		msgContent = ""
	}

	choice := Choice{
		Index: 0,
		Message: ChatMessage{
			Role:      RoleAssistant,
			Content:   msgContent,
			Reasoning: reasoning,
			ToolCalls: toolCalls,
		},
		FinishReason: mapAnthropicFinishReason(j["stop_reason"]),
	}

	return &ChatResponse{
		ID:       id,
		Model:    model,
		Provider: "anthropic",
		Created:  0,
		Choices:  []Choice{choice},
		Usage:    parseAnthropicUsage(j["usage"].(map[string]any)),
	}, nil
}

func (a *AnthropicAdapter) TranslateChunk(chunkJSON []byte, providerModel string) (*ChatChunk, error) {
	return nil, nil // Streaming processed directly in ExecuteStream via Anthropic SSE event protocol
}

func (a *AnthropicAdapter) Execute(ctx context.Context, route *NormalizedRoute, apiKey string, req *ChatRequest, client *http.Client) (*ChatResponse, error) {
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
	url := strings.TrimRight(baseURL, "/") + "/messages"

	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-api-key", apiKey)
	httpReq.Header.Set("anthropic-version", "2023-06-01")
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

	if err := RequireOK(resp, "anthropic", respBytes); err != nil {
		return nil, err
	}

	return a.TranslateResponse(respBytes, route.Model)
}

func (a *AnthropicAdapter) ExecuteStream(ctx context.Context, route *NormalizedRoute, apiKey string, req *ChatRequest, client *http.Client) (<-chan ChatChunk, <-chan error, error) {
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
	url := strings.TrimRight(baseURL, "/") + "/messages"

	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	httpReq.Header.Set("x-api-key", apiKey)
	httpReq.Header.Set("anthropic-version", "2023-06-01")
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
		return nil, nil, RequireOK(resp, "anthropic", respBytes)
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
			evType, _ := ev["type"].(string)
			switch evType {
			case "message_start":
				if !sentRole {
					sentRole = true
					role := RoleAssistant
					chunkChan <- ChatChunk{
						ID:       "",
						Model:    route.Model,
						Provider: "anthropic",
						Delta:    Delta{Role: &role},
					}
				}
			case "content_block_delta":
				deltaMap, _ := ev["delta"].(map[string]any)
				dType, _ := deltaMap["type"].(string)
				if dType == "text_delta" {
					if t, ok := deltaMap["text"].(string); ok {
						chunkChan <- ChatChunk{
							ID:       "",
							Model:    route.Model,
							Provider: "anthropic",
							Delta:    Delta{Content: &t},
						}
					}
				} else if dType == "thinking_delta" {
					if th, ok := deltaMap["thinking"].(string); ok {
						chunkChan <- ChatChunk{
							ID:       "",
							Model:    route.Model,
							Provider: "anthropic",
							Delta:    Delta{Reasoning: &th},
						}
					}
				} else if dType == "input_json_delta" {
					if partial, ok := deltaMap["partial_json"].(string); ok {
						chunkChan <- ChatChunk{
							ID:       "",
							Model:    route.Model,
							Provider: "anthropic",
							Delta: Delta{
								ToolCalls: []ToolCallDelta{
									{
										Index:    0,
										Function: &ToolCallDeltaFunction{Arguments: &partial},
									},
								},
							},
						}
					}
				}
			case "content_block_start":
				cb, _ := ev["content_block"].(map[string]any)
				if cb["type"] == "tool_use" {
					tcID, _ := cb["id"].(string)
					tcName, _ := cb["name"].(string)
					tcType := "function"
					chunkChan <- ChatChunk{
						ID:       "",
						Model:    route.Model,
						Provider: "anthropic",
						Delta: Delta{
							ToolCalls: []ToolCallDelta{
								{
									Index:    0,
									ID:       &tcID,
									Type:     &tcType,
									Function: &ToolCallDeltaFunction{Name: &tcName},
								},
							},
						},
					}
				}
			case "message_delta":
				var usage *Usage
				if uMap, ok := ev["usage"].(map[string]any); ok {
					usage = parseAnthropicUsage(uMap)
				}
				deltaMap, _ := ev["delta"].(map[string]any)
				finishReason := mapAnthropicFinishReason(deltaMap["stop_reason"])
				chunkChan <- ChatChunk{
					ID:           "",
					Model:        route.Model,
					Provider:     "anthropic",
					Delta:        Delta{},
					FinishReason: finishReason,
					Usage:        usage,
				}
			}
		}
	}()

	return chunkChan, errChan, nil
}

func (a *AnthropicAdapter) ExecuteRaw(ctx context.Context, route *NormalizedRoute, apiKey string, opts RawRequestOptions, client *http.Client) (*http.Response, error) {
	baseURL := route.BaseURL
	if baseURL == "" {
		baseURL = a.DefaultBaseURL
	}
	path := opts.Path
	if path == "" {
		path = "/messages"
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
	httpReq.Header.Set("x-api-key", apiKey)
	httpReq.Header.Set("anthropic-version", "2023-06-01")
	for k, v := range opts.Headers {
		httpReq.Header.Set(k, v)
	}

	if client == nil {
		client = http.DefaultClient
	}
	return client.Do(httpReq)
}

func (a *AnthropicAdapter) Embed(ctx context.Context, route *NormalizedRoute, apiKey string, req *EmbeddingRequest, client *http.Client) (*EmbeddingResponse, error) {
	return nil, fmt.Errorf("anthropic does not support embeddings")
}
