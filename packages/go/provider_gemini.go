package airouter

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
)

// GeminiAdapter implements ProviderAdapter for Google Gemini.
type GeminiAdapter struct {
	DefaultBaseURL string
}

func NewGeminiAdapter() *GeminiAdapter {
	return &GeminiAdapter{
		DefaultBaseURL: "https://generativelanguage.googleapis.com/v1beta",
	}
}

type geminiTurn struct {
	role  string
	parts []map[string]any
}

func guessGeminiMime(imgURL string) string {
	u, err := url.Parse(imgURL)
	if err != nil {
		return "image/jpeg"
	}
	ext := strings.ToLower(path.Ext(u.Path))
	switch ext {
	case ".png":
		return "image/png"
	case ".webp":
		return "image/webp"
	case ".gif":
		return "image/gif"
	default:
		return "image/jpeg"
	}
}

func parseGeminiImage(url string) map[string]any {
	dataURIPattern := regexp.MustCompile(`(?i)^data:([^;,]+);base64,(.*)$`)
	if matches := dataURIPattern.FindStringSubmatch(url); len(matches) == 3 {
		return map[string]any{
			"inlineData": map[string]any{
				"mimeType": matches[1],
				"data":     matches[2],
			},
		}
	}
	if strings.HasPrefix(strings.ToLower(url), "http://") || strings.HasPrefix(strings.ToLower(url), "https://") {
		return map[string]any{
			"fileData": map[string]any{
				"mimeType": guessGeminiMime(url),
				"fileUri":  url,
			},
		}
	}
	return nil
}

func (a *GeminiAdapter) TranslateRequest(req *ChatRequest, providerModel string, stream bool) (map[string]any, error) {
	var systemParts []string
	callNames := map[string]string{}

	for _, msg := range req.Messages {
		for _, tc := range msg.ToolCalls {
			if tc.ID != "" {
				callNames[tc.ID] = tc.Function.Name
			}
		}
	}

	var turns []geminiTurn
	push := func(role string, part map[string]any) {
		if len(turns) > 0 && turns[len(turns)-1].role == role {
			turns[len(turns)-1].parts = append(turns[len(turns)-1].parts, part)
		} else {
			turns = append(turns, geminiTurn{role: role, parts: []map[string]any{part}})
		}
	}

	for _, msg := range req.Messages {
		if msg.Role == RoleSystem {
			if str, ok := msg.Content.(string); ok && str != "" {
				systemParts = append(systemParts, str)
			} else if list, ok := msg.Content.([]any); ok {
				for _, p := range list {
					if cp, ok := p.(ContentPart); ok && cp.Type == "text" && cp.Text != "" {
						systemParts = append(systemParts, cp.Text)
					} else if pMap, ok := p.(map[string]any); ok && pMap["type"] == "text" {
						if t, ok := pMap["text"].(string); ok && t != "" {
							systemParts = append(systemParts, t)
						}
					}
				}
			}
			continue
		}

		if msg.Role == RoleTool {
			id := msg.ToolCallID
			name := callNames[id]
			if name == "" {
				name = msg.Name
			}
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
			fnResp := map[string]any{
				"name":     name,
				"response": map[string]any{"result": resultText},
			}
			if id != "" {
				fnResp["id"] = id
			}
			push("user", map[string]any{
				"functionResponse": fnResp,
			})
			continue
		}

		role := "user"
		if msg.Role == RoleAssistant {
			role = "model"
		}

		if str, ok := msg.Content.(string); ok && str != "" {
			push(role, map[string]any{"text": str})
		} else if list, ok := msg.Content.([]any); ok {
			for _, p := range list {
				if cp, ok := p.(ContentPart); ok {
					if cp.Type == "text" && cp.Text != "" {
						push(role, map[string]any{"text": cp.Text})
					} else if cp.Type == "image_url" && cp.ImageURL != nil {
						if img := parseGeminiImage(cp.ImageURL.URL); img != nil {
							push(role, img)
						}
					}
				} else if pMap, ok := p.(map[string]any); ok {
					if pMap["type"] == "text" {
						if t, ok := pMap["text"].(string); ok && t != "" {
							push(role, map[string]any{"text": t})
						}
					} else if pMap["type"] == "image_url" {
						if imgObj, ok := pMap["image_url"].(map[string]any); ok {
							if u, ok := imgObj["url"].(string); ok {
								if img := parseGeminiImage(u); img != nil {
									push(role, img)
								}
							}
						}
					}
				}
			}
		}

		for _, tc := range msg.ToolCalls {
			var args any = map[string]any{}
			if tc.Function.Arguments != "" {
				_ = json.Unmarshal([]byte(tc.Function.Arguments), &args)
			}
			fcMap := map[string]any{
				"name": tc.Function.Name,
				"args": args,
			}
			if tc.ID != "" {
				fcMap["id"] = tc.ID
			}
			push(role, map[string]any{
				"functionCall": fcMap,
			})
		}
	}

	contents := make([]map[string]any, len(turns))
	for i, t := range turns {
		contents[i] = map[string]any{"role": t.role, "parts": t.parts}
	}

	body := map[string]any{
		"contents": contents,
	}

	if len(systemParts) > 0 {
		sysList := make([]map[string]any, len(systemParts))
		for i, s := range systemParts {
			sysList[i] = map[string]any{"text": s}
		}
		body["systemInstruction"] = map[string]any{"parts": sysList}
	}

	genConfig := map[string]any{}
	if req.Temperature != nil {
		genConfig["temperature"] = *req.Temperature
	}
	if req.TopP != nil {
		genConfig["topP"] = *req.TopP
	}
	if req.MaxTokens != nil {
		genConfig["maxOutputTokens"] = *req.MaxTokens
	}
	if req.Stop != nil {
		if list, ok := req.Stop.([]string); ok {
			genConfig["stopSequences"] = list
		} else if list, ok := req.Stop.([]any); ok {
			genConfig["stopSequences"] = list
		} else if str, ok := req.Stop.(string); ok {
			genConfig["stopSequences"] = []string{str}
		}
	}
	if req.ResponseFormat != nil {
		if req.ResponseFormat.Type == "json_object" {
			genConfig["responseMimeType"] = "application/json"
		} else if req.ResponseFormat.Type == "json_schema" && req.ResponseFormat.JSONSchema != nil {
			genConfig["responseMimeType"] = "application/json"
			genConfig["responseJsonSchema"] = req.ResponseFormat.JSONSchema.Schema
		}
	}
	if req.ReasoningEffort != "" {
		budgets := map[string]int{"low": 1024, "medium": 8192, "high": 24576}
		budget := budgets[req.ReasoningEffort]
		if budget == 0 {
			budget = 8192
		}
		genConfig["thinkingConfig"] = map[string]any{
			"thinkingBudget":  budget,
			"includeThoughts": true,
		}
	}
	if len(genConfig) > 0 {
		body["generationConfig"] = genConfig
	}

	sendTools := req.ToolChoice != "none" && len(req.Tools) > 0
	if sendTools {
		fnDecls := make([]map[string]any, len(req.Tools))
		for i, t := range req.Tools {
			fnDecls[i] = map[string]any{
				"name":       t.Function.Name,
				"parameters": t.Function.Parameters,
			}
			if t.Function.Description != "" {
				fnDecls[i]["description"] = t.Function.Description
			}
		}
		body["tools"] = []map[string]any{{"functionDeclarations": fnDecls}}

		if choice, ok := req.ToolChoice.(string); ok {
			if choice == "auto" {
				body["toolConfig"] = map[string]any{"functionCallingConfig": map[string]any{"mode": "AUTO"}}
			} else if choice == "required" {
				body["toolConfig"] = map[string]any{"functionCallingConfig": map[string]any{"mode": "ANY"}}
			}
		} else if choiceMap, ok := req.ToolChoice.(map[string]any); ok {
			if fn, ok := choiceMap["function"].(map[string]any); ok {
				if name, ok := fn["name"].(string); ok {
					body["toolConfig"] = map[string]any{
						"functionCallingConfig": map[string]any{
							"mode":                 "ANY",
							"allowedFunctionNames": []string{name},
						},
					}
				}
			}
		}
	}

	if req.ProviderOptions != nil {
		if extra, ok := req.ProviderOptions["gemini"]; ok {
			for k, v := range extra {
				body[k] = v
			}
		}
	}

	return body, nil
}

func parseGeminiUsage(uMap map[string]any) *Usage {
	if uMap == nil {
		return nil
	}
	prompt, _ := uMap["promptTokenCount"].(float64)
	comp, _ := uMap["candidatesTokenCount"].(float64)
	tot, _ := uMap["totalTokenCount"].(float64)
	if tot == 0 {
		tot = prompt + comp
	}

	var cached *int
	if c, ok := uMap["cachedContentTokenCount"].(float64); ok && c > 0 {
		cVal := int(c)
		cached = &cVal
	}
	var thoughts *int
	if th, ok := uMap["thoughtsTokenCount"].(float64); ok && th > 0 {
		thVal := int(th)
		thoughts = &thVal
	}

	return &Usage{
		PromptTokens:     int(prompt),
		CompletionTokens: int(comp),
		TotalTokens:      int(tot),
		CachedTokens:     cached,
		ReasoningTokens:  thoughts,
	}
}

func mapGeminiFinishReason(finishReason any) *string {
	if finishReason == nil {
		return nil
	}
	str, ok := finishReason.(string)
	if !ok {
		return nil
	}
	var res string
	switch str {
	case "STOP":
		res = "stop"
	case "MAX_TOKENS":
		res = "length"
	case "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT":
		res = "content_filter"
	default:
		res = str
	}
	return &res
}

func (a *GeminiAdapter) TranslateResponse(body []byte, providerModel string) (*ChatResponse, error) {
	var j map[string]any
	if err := json.Unmarshal(body, &j); err != nil {
		return nil, err
	}

	candidates, _ := j["candidates"].([]any)
	blocked := false
	if pf, ok := j["promptFeedback"].(map[string]any); ok && pf["blockReason"] != nil {
		blocked = true
	}

	var text string
	var reasoning string
	var toolCalls []ToolCall
	var finishReason *string

	if len(candidates) > 0 {
		if cand, ok := candidates[0].(map[string]any); ok {
			finishReason = mapGeminiFinishReason(cand["finishReason"])
			if content, ok := cand["content"].(map[string]any); ok {
				if parts, ok := content["parts"].([]any); ok {
					for _, pVal := range parts {
						if pMap, ok := pVal.(map[string]any); ok {
							if t, ok := pMap["text"].(string); ok {
								if thought, ok := pMap["thought"].(bool); ok && thought {
									reasoning += t
								} else {
									text += t
								}
							} else if fc, ok := pMap["functionCall"].(map[string]any); ok {
								idx := len(toolCalls)
								id, _ := fc["id"].(string)
								if id == "" {
									id = fmt.Sprintf("call_%d", idx)
								}
								name, _ := fc["name"].(string)
								argsBytes, _ := json.Marshal(fc["args"])
								toolCalls = append(toolCalls, ToolCall{
									ID:   id,
									Type: "function",
									Function: ToolCallFunction{
										Name:      name,
										Arguments: string(argsBytes),
									},
								})
							}
						}
					}
				}
			}
		}
	} else if blocked {
		cf := "content_filter"
		finishReason = &cf
	}

	var msgContent any
	if text != "" {
		msgContent = text
	} else if len(toolCalls) == 0 {
		msgContent = ""
	}

	var usage *Usage
	if uMap, ok := j["usageMetadata"].(map[string]any); ok {
		usage = parseGeminiUsage(uMap)
	}

	choice := Choice{
		Index: 0,
		Message: ChatMessage{
			Role:      RoleAssistant,
			Content:   msgContent,
			Reasoning: reasoning,
			ToolCalls: toolCalls,
		},
		FinishReason: finishReason,
	}

	id, _ := j["responseId"].(string)
	if id == "" {
		id, _ = j["id"].(string)
	}
	model, _ := j["modelVersion"].(string)
	if model == "" {
		model, _ = j["model"].(string)
	}
	if model == "" {
		model = providerModel
	}

	return &ChatResponse{
		ID:       id,
		Model:    model,
		Provider: "gemini",
		Created:  0,
		Choices:  []Choice{choice},
		Usage:    usage,
	}, nil
}

func (a *GeminiAdapter) TranslateChunk(chunkJSON []byte, providerModel string) (*ChatChunk, error) {
	return nil, nil
}

func (a *GeminiAdapter) Execute(ctx context.Context, route *NormalizedRoute, apiKey string, req *ChatRequest, client *http.Client) (*ChatResponse, error) {
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
	url := fmt.Sprintf("%s/models/%s:generateContent?key=%s", strings.TrimRight(baseURL, "/"), route.Model, apiKey)

	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
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

	if err := RequireOK(resp, "gemini", respBytes); err != nil {
		return nil, err
	}

	return a.TranslateResponse(respBytes, route.Model)
}

func (a *GeminiAdapter) ExecuteStream(ctx context.Context, route *NormalizedRoute, apiKey string, req *ChatRequest, client *http.Client) (<-chan ChatChunk, <-chan error, error) {
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
	url := fmt.Sprintf("%s/models/%s:streamGenerateContent?alt=sse&key=%s", strings.TrimRight(baseURL, "/"), route.Model, apiKey)

	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
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
		return nil, nil, RequireOK(resp, "gemini", respBytes)
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
					Provider: "gemini",
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
										if thought, ok := pMap["thought"].(bool); ok && thought {
											chunkChan <- ChatChunk{
												ID:       "",
												Model:    route.Model,
												Provider: "gemini",
												Delta:    Delta{Reasoning: &t},
											}
										} else {
											chunkChan <- ChatChunk{
												ID:       "",
												Model:    route.Model,
												Provider: "gemini",
												Delta:    Delta{Content: &t},
											}
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
							Provider:     "gemini",
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

func (a *GeminiAdapter) ExecuteRaw(ctx context.Context, route *NormalizedRoute, apiKey string, opts RawRequestOptions, client *http.Client) (*http.Response, error) {
	baseURL := route.BaseURL
	if baseURL == "" {
		baseURL = a.DefaultBaseURL
	}
	path := opts.Path
	if path == "" {
		path = fmt.Sprintf("/models/%s:generateContent", route.Model)
	}
	url := fmt.Sprintf("%s/%s?key=%s", strings.TrimRight(baseURL, "/"), strings.TrimLeft(path, "/"), apiKey)

	bodyBytes, err := json.Marshal(opts.Body)
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	for k, v := range opts.Headers {
		httpReq.Header.Set(k, v)
	}

	if client == nil {
		client = http.DefaultClient
	}
	return client.Do(httpReq)
}

func (a *GeminiAdapter) Embed(ctx context.Context, route *NormalizedRoute, apiKey string, req *EmbeddingRequest, client *http.Client) (*EmbeddingResponse, error) {
	baseURL := route.BaseURL
	if baseURL == "" {
		baseURL = a.DefaultBaseURL
	}
	url := fmt.Sprintf("%s/models/%s:embedContent?key=%s", strings.TrimRight(baseURL, "/"), route.Model, apiKey)

	bodyMap := map[string]any{
		"model": fmt.Sprintf("models/%s", route.Model),
		"content": map[string]any{
			"parts": []map[string]any{{"text": req.Input}},
		},
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

	if err := RequireOK(resp, "gemini", respBytes); err != nil {
		return nil, err
	}

	var j map[string]any
	if err := json.Unmarshal(respBytes, &j); err != nil {
		return nil, err
	}

	var vec []float64
	if emb, ok := j["embedding"].(map[string]any); ok {
		if vals, ok := emb["values"].([]any); ok {
			for _, v := range vals {
				if f, ok := v.(float64); ok {
					vec = append(vec, f)
				}
			}
		}
	}

	return &EmbeddingResponse{
		Object:   "list",
		Model:    route.Model,
		Provider: "gemini",
		Data: []EmbeddingData{
			{Index: 0, Embedding: vec},
		},
	}, nil
}
