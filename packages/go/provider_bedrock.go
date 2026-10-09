package airouter

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// BedrockAdapter implements ProviderAdapter for AWS Bedrock Converse with AWS SigV4.
type BedrockAdapter struct{}

func NewBedrockAdapter() *BedrockAdapter {
	return &BedrockAdapter{}
}

type awsCredentials struct {
	accessKeyID     string
	secretAccessKey string
	sessionToken    string
}

func parseAwsCredentials(key string) (awsCredentials, error) {
	parts := strings.Split(key, ":")
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		return awsCredentials{}, &ConfigError{Message: `route: bedrock apiKey must be "ACCESS_KEY_ID:SECRET_ACCESS_KEY[:SESSION_TOKEN]"`}
	}
	creds := awsCredentials{
		accessKeyID:     parts[0],
		secretAccessKey: parts[1],
	}
	if len(parts) > 2 {
		creds.sessionToken = parts[2]
	}
	return creds, nil
}

func hmacSHA256(key []byte, data []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write(data)
	return h.Sum(nil)
}

func sha256Hex(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

func signSigV4(method, reqURL string, body []byte, creds awsCredentials, region, service string, t time.Time) (map[string]string, error) {
	u, err := url.Parse(reqURL)
	if err != nil {
		return nil, err
	}

	amzDate := t.UTC().Format("20060102T150405Z")
	dateStamp := t.UTC().Format("20060102")

	host := u.Host
	canonicalURI := u.EscapedPath()
	if canonicalURI == "" {
		canonicalURI = "/"
	}

	canonicalHeaders := fmt.Sprintf("content-type:application/json\nhost:%s\nx-amz-date:%s\n", host, amzDate)
	signedHeaders := "content-type;host;x-amz-date"

	if creds.sessionToken != "" {
		canonicalHeaders = fmt.Sprintf("content-type:application/json\nhost:%s\nx-amz-date:%s\nx-amz-security-token:%s\n", host, amzDate, creds.sessionToken)
		signedHeaders = "content-type;host;x-amz-date;x-amz-security-token"
	}

	payloadHash := sha256Hex(body)
	canonicalRequest := strings.Join([]string{
		method,
		canonicalURI,
		u.RawQuery,
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	}, "\n")

	scope := fmt.Sprintf("%s/%s/%s/aws4_request", dateStamp, region, service)
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		sha256Hex([]byte(canonicalRequest)),
	}, "\n")

	kDate := hmacSHA256([]byte("AWS4"+creds.secretAccessKey), []byte(dateStamp))
	kRegion := hmacSHA256(kDate, []byte(region))
	kService := hmacSHA256(kRegion, []byte(service))
	kSigning := hmacSHA256(kService, []byte("aws4_request"))

	signature := hex.EncodeToString(hmacSHA256(kSigning, []byte(stringToSign)))

	authHeader := fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		creds.accessKeyID, scope, signedHeaders, signature)

	headers := map[string]string{
		"Content-Type":  "application/json",
		"X-Amz-Date":    amzDate,
		"Authorization": authHeader,
	}
	if creds.sessionToken != "" {
		headers["X-Amz-Security-Token"] = creds.sessionToken
	}
	return headers, nil
}

type bedrockTurn struct {
	role    string
	content []map[string]any
}

func parseBedrockImage(url string) map[string]any {
	dataURIPattern := regexp.MustCompile(`(?i)^data:([^;,]+);base64,(.*)$`)
	matches := dataURIPattern.FindStringSubmatch(url)
	if len(matches) != 3 {
		return nil
	}
	mime := strings.ToLower(matches[1])
	var format string
	switch mime {
	case "image/png":
		format = "png"
	case "image/jpeg":
		format = "jpeg"
	case "image/gif":
		format = "gif"
	case "image/webp":
		format = "webp"
	default:
		return nil
	}
	return map[string]any{
		"image": map[string]any{
			"format": format,
			"source": map[string]any{"bytes": matches[2]},
		},
	}
}

func (a *BedrockAdapter) TranslateRequest(req *ChatRequest, providerModel string, stream bool) (map[string]any, error) {
	var systemParts []string
	var turns []bedrockTurn

	push := func(role string, block map[string]any) {
		if len(turns) > 0 && turns[len(turns)-1].role == role {
			turns[len(turns)-1].content = append(turns[len(turns)-1].content, block)
		} else {
			turns = append(turns, bedrockTurn{role: role, content: []map[string]any{block}})
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
				"toolResult": map[string]any{
					"toolUseId": msg.ToolCallID,
					"content":   []map[string]any{{"text": resultText}},
				},
			})
			continue
		}

		role := "user"
		if msg.Role == RoleAssistant {
			role = "assistant"
		}

		if str, ok := msg.Content.(string); ok && str != "" {
			push(role, map[string]any{"text": str})
		} else if list, ok := msg.Content.([]any); ok {
			for _, p := range list {
				if cp, ok := p.(ContentPart); ok {
					if cp.Type == "text" && cp.Text != "" {
						push(role, map[string]any{"text": cp.Text})
					} else if cp.Type == "image_url" && cp.ImageURL != nil {
						if img := parseBedrockImage(cp.ImageURL.URL); img != nil {
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
								if img := parseBedrockImage(u); img != nil {
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
			push(role, map[string]any{
				"toolUse": map[string]any{
					"toolUseId": tc.ID,
					"name":      tc.Function.Name,
					"input":     args,
				},
			})
		}
	}

	messages := make([]map[string]any, len(turns))
	for i, t := range turns {
		messages[i] = map[string]any{"role": t.role, "content": t.content}
	}

	body := map[string]any{
		"messages": messages,
	}

	if len(systemParts) > 0 {
		body["system"] = []map[string]any{{"text": strings.Join(systemParts, "\n\n")}}
	}

	infConfig := map[string]any{}
	if req.Temperature != nil {
		infConfig["temperature"] = *req.Temperature
	}
	if req.TopP != nil {
		infConfig["topP"] = *req.TopP
	}
	if req.MaxTokens != nil {
		infConfig["maxTokens"] = *req.MaxTokens
	}
	if req.Stop != nil {
		if list, ok := req.Stop.([]string); ok {
			infConfig["stopSequences"] = list
		} else if list, ok := req.Stop.([]any); ok {
			infConfig["stopSequences"] = list
		} else if str, ok := req.Stop.(string); ok {
			infConfig["stopSequences"] = []string{str}
		}
	}
	if len(infConfig) > 0 {
		body["inferenceConfig"] = infConfig
	}

	sendTools := req.ToolChoice != "none" && len(req.Tools) > 0
	if sendTools {
		var bedrockTools []map[string]any
		for _, t := range req.Tools {
			spec := map[string]any{
				"name":        t.Function.Name,
				"inputSchema": map[string]any{"json": t.Function.Parameters},
			}
			if t.Function.Description != "" {
				spec["description"] = t.Function.Description
			}
			bedrockTools = append(bedrockTools, map[string]any{"toolSpec": spec})
		}

		toolConfig := map[string]any{"tools": bedrockTools}
		if choice, ok := req.ToolChoice.(string); ok {
			if choice == "auto" {
				toolConfig["toolChoice"] = map[string]any{"auto": map[string]any{}}
			} else if choice == "required" {
				toolConfig["toolChoice"] = map[string]any{"any": map[string]any{}}
			}
		} else if choiceMap, ok := req.ToolChoice.(map[string]any); ok {
			if fn, ok := choiceMap["function"].(map[string]any); ok {
				if name, ok := fn["name"].(string); ok {
					toolConfig["toolChoice"] = map[string]any{"tool": map[string]any{"name": name}}
				}
			}
		}
		body["toolConfig"] = toolConfig
	}

	if req.ProviderOptions != nil {
		if extra, ok := req.ProviderOptions["bedrock"]; ok {
			for k, v := range extra {
				body[k] = v
			}
		}
	}

	return body, nil
}

func parseBedrockUsage(uMap map[string]any) *Usage {
	if uMap == nil {
		return nil
	}
	inp, _ := uMap["inputTokens"].(float64)
	out, _ := uMap["outputTokens"].(float64)
	tot, _ := uMap["totalTokens"].(float64)
	if tot == 0 {
		tot = inp + out
	}
	cacheRead, _ := uMap["cacheReadInputTokens"].(float64)
	cacheWrite, _ := uMap["cacheWriteInputTokens"].(float64)

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

	return &Usage{
		PromptTokens:     int(inp),
		CompletionTokens: int(out),
		TotalTokens:      int(tot),
		CachedTokens:     cr,
		CacheWriteTokens: cw,
	}
}

func mapBedrockStopReason(stopReason any) *string {
	if stopReason == nil {
		return nil
	}
	str, ok := stopReason.(string)
	if !ok {
		return nil
	}
	var res string
	switch str {
	case "end_turn", "stop_sequence":
		res = "stop"
	case "max_tokens":
		res = "length"
	case "tool_use":
		res = "tool_calls"
	case "content_filtered", "guardrail_intervened":
		res = "content_filter"
	default:
		res = str
	}
	return &res
}

func (a *BedrockAdapter) TranslateResponse(body []byte, providerModel string) (*ChatResponse, error) {
	var j map[string]any
	if err := json.Unmarshal(body, &j); err != nil {
		return nil, err
	}

	output, _ := j["output"].(map[string]any)
	message, _ := output["message"].(map[string]any)
	blocks, _ := message["content"].([]any)

	var text string
	var reasoning string
	var toolCalls []ToolCall

	for _, bVal := range blocks {
		if bMap, ok := bVal.(map[string]any); ok {
			if t, ok := bMap["text"].(string); ok {
				text += t
			} else if rc, ok := bMap["reasoningContent"].(map[string]any); ok {
				if rText, ok := rc["text"].(string); ok {
					reasoning += rText
				}
			} else if tu, ok := bMap["toolUse"].(map[string]any); ok {
				id, _ := tu["toolUseId"].(string)
				name, _ := tu["name"].(string)
				argsBytes, _ := json.Marshal(tu["input"])
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

	var msgContent any
	if text != "" {
		msgContent = text
	} else if len(toolCalls) == 0 {
		msgContent = ""
	}

	var usage *Usage
	if uMap, ok := j["usage"].(map[string]any); ok {
		usage = parseBedrockUsage(uMap)
	}

	msgID, _ := j["messageId"].(string)
	choice := Choice{
		Index: 0,
		Message: ChatMessage{
			Role:      RoleAssistant,
			Content:   msgContent,
			Reasoning: reasoning,
			ToolCalls: toolCalls,
		},
		FinishReason: mapBedrockStopReason(j["stopReason"]),
	}

	return &ChatResponse{
		ID:       msgID,
		Model:    providerModel,
		Provider: "bedrock",
		Created:  0,
		Choices:  []Choice{choice},
		Usage:    usage,
	}, nil
}

func (a *BedrockAdapter) TranslateChunk(chunkJSON []byte, providerModel string) (*ChatChunk, error) {
	return nil, nil
}

func (a *BedrockAdapter) Execute(ctx context.Context, route *NormalizedRoute, apiKey string, req *ChatRequest, client *http.Client) (*ChatResponse, error) {
	if route.Region == "" {
		return nil, &ConfigError{Message: fmt.Sprintf("route %q: bedrock provider requires region", route.ID)}
	}
	creds, err := parseAwsCredentials(apiKey)
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

	baseURL := route.BaseURL
	if baseURL == "" {
		baseURL = fmt.Sprintf("https://bedrock-runtime.%s.amazonaws.com", route.Region)
	}
	url := fmt.Sprintf("%s/model/%s/converse", strings.TrimRight(baseURL, "/"), url.PathEscape(route.Model))

	sigHeaders, err := signSigV4("POST", url, bodyBytes, creds, route.Region, "bedrock", time.Now())
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	for k, v := range sigHeaders {
		httpReq.Header.Set(k, v)
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

	if err := RequireOK(resp, "bedrock", respBytes); err != nil {
		return nil, err
	}

	return a.TranslateResponse(respBytes, route.Model)
}

func (a *BedrockAdapter) ExecuteStream(ctx context.Context, route *NormalizedRoute, apiKey string, req *ChatRequest, client *http.Client) (<-chan ChatChunk, <-chan error, error) {
	return nil, nil, fmt.Errorf("bedrock streaming via converse-stream requires binary event-stream decoding")
}

func (a *BedrockAdapter) ExecuteRaw(ctx context.Context, route *NormalizedRoute, apiKey string, opts RawRequestOptions, client *http.Client) (*http.Response, error) {
	if route.Region == "" {
		return nil, &ConfigError{Message: fmt.Sprintf("route %q: bedrock provider requires region", route.ID)}
	}
	creds, err := parseAwsCredentials(apiKey)
	if err != nil {
		return nil, err
	}

	baseURL := route.BaseURL
	if baseURL == "" {
		baseURL = fmt.Sprintf("https://bedrock-runtime.%s.amazonaws.com", route.Region)
	}
	path := opts.Path
	if path == "" {
		path = fmt.Sprintf("/model/%s/converse", url.PathEscape(route.Model))
	}
	reqURL := strings.TrimRight(baseURL, "/") + "/" + strings.TrimLeft(path, "/")

	bodyBytes, err := json.Marshal(opts.Body)
	if err != nil {
		return nil, err
	}

	sigHeaders, err := signSigV4("POST", reqURL, bodyBytes, creds, route.Region, "bedrock", time.Now())
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", reqURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	for k, v := range sigHeaders {
		httpReq.Header.Set(k, v)
	}
	for k, v := range opts.Headers {
		httpReq.Header.Set(k, v)
	}

	if client == nil {
		client = http.DefaultClient
	}
	return client.Do(httpReq)
}

func (a *BedrockAdapter) Embed(ctx context.Context, route *NormalizedRoute, apiKey string, req *EmbeddingRequest, client *http.Client) (*EmbeddingResponse, error) {
	return nil, fmt.Errorf("bedrock embeddings not supported directly")
}
