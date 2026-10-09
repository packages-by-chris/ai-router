package airouter

import (
	"encoding/json"
)

// Role defines the participant role in a conversation.
type Role = string

const (
	RoleSystem    Role = "system"
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
	RoleTool      Role = "tool"
)

// ToolCallFunction holds function name and serialized JSON arguments.
type ToolCallFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// ToolCall represents a tool invocation requested by the assistant.
type ToolCall struct {
	ID       string           `json:"id"`
	Type     string           `json:"type"` // "function"
	Function ToolCallFunction `json:"function"`
}

// ContentPart represents multimodal message content.
type ContentPart struct {
	Type     string         `json:"type"` // "text" | "image_url"
	Text     string         `json:"text,omitempty"`
	ImageURL *ImageURLField `json:"image_url,omitempty"`
}

// ImageURLField holds url and optional detail level.
type ImageURLField struct {
	URL    string `json:"url"`
	Detail string `json:"detail,omitempty"`
}

// ChatMessage represents a single message in a chat history.
type ChatMessage struct {
	Role            Role                      `json:"role"`
	Content         any                       `json:"content,omitempty"` // string, []ContentPart, []any, or nil
	Name            string                    `json:"name,omitempty"`
	ToolCalls       []ToolCall                `json:"tool_calls,omitempty"`
	ToolCallID      string                    `json:"tool_call_id,omitempty"`
	Reasoning       string                    `json:"reasoning,omitempty"`
	ProviderOptions map[string]map[string]any `json:"providerOptions,omitempty"`
}

// ToolFunction defines a tool's callable signature and JSON schema parameters.
type ToolFunction struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Parameters  map[string]any `json:"parameters,omitempty"`
}

// Tool defines an invokable tool.
type Tool struct {
	Type     string       `json:"type"` // "function"
	Function ToolFunction `json:"function"`
}

// ResponseFormat defines the expected output schema (text, json_object, json_schema).
type ResponseFormat struct {
	Type       string          `json:"type"` // "text" | "json_object" | "json_schema"
	JSONSchema *JSONSchemaInfo `json:"json_schema,omitempty"`
}

// JSONSchemaInfo holds schema details for structured outputs.
type JSONSchemaInfo struct {
	Name   string         `json:"name,omitempty"`
	Schema map[string]any `json:"schema,omitempty"`
	Strict *bool          `json:"strict,omitempty"`
}

// ChatRequest represents the unified request shape.
type ChatRequest struct {
	Model           string                    `json:"model"` // Logical route ID
	Messages        []ChatMessage             `json:"messages"`
	Tools           []Tool                    `json:"tools,omitempty"`
	ToolChoice      any                       `json:"tool_choice,omitempty"` // "none" | "auto" | "required" | map
	Temperature     *float64                  `json:"temperature,omitempty"`
	TopP            *float64                  `json:"top_p,omitempty"`
	MaxTokens       *int                      `json:"max_tokens,omitempty"`
	Stop            any                       `json:"stop,omitempty"` // string or []string
	ResponseFormat  *ResponseFormat           `json:"response_format,omitempty"`
	ReasoningEffort string                    `json:"reasoning_effort,omitempty"` // "low" | "medium" | "high"
	ProviderOptions map[string]map[string]any `json:"providerOptions,omitempty"`
	User            string                    `json:"user,omitempty"`
}

// Usage captures token counts and reasoning / cache stats.
type Usage struct {
	PromptTokens     int  `json:"prompt_tokens"`
	CompletionTokens int  `json:"completion_tokens"`
	TotalTokens      int  `json:"total_tokens"`
	CachedTokens     *int `json:"cached_tokens,omitempty"`
	CacheWriteTokens *int `json:"cache_write_tokens,omitempty"`
	ReasoningTokens  *int `json:"reasoning_tokens,omitempty"`
}

// TokenPrice contains per-token pricing for cost calculations.
type TokenPrice struct {
	Input      float64  `json:"input"`
	Output     float64  `json:"output"`
	CacheRead  *float64 `json:"cache_read,omitempty"`
	CacheWrite *float64 `json:"cache_write,omitempty"`
}

// Choice represents a completion candidate in a response.
type Choice struct {
	Index        int         `json:"index"`
	Message      ChatMessage `json:"message"`
	FinishReason *string     `json:"finish_reason"`
}

// ChatResponse represents a unified non-streaming response.
type ChatResponse struct {
	ID       string   `json:"id"`
	Model    string   `json:"model"`
	Provider string   `json:"provider"`
	Created  int64    `json:"created"`
	Choices  []Choice `json:"choices"`
	Usage    *Usage   `json:"usage,omitempty"`
	CostUSD  *float64 `json:"cost_usd,omitempty"`
}

// ToolCallDeltaFunction contains partial function arguments during streaming.
type ToolCallDeltaFunction struct {
	Name      *string `json:"name,omitempty"`
	Arguments *string `json:"arguments,omitempty"`
}

// ToolCallDelta represents streamed incremental tool call tokens.
type ToolCallDelta struct {
	Index    int                    `json:"index"`
	ID       *string                `json:"id,omitempty"`
	Type     *string                `json:"type,omitempty"`
	Function *ToolCallDeltaFunction `json:"function,omitempty"`
}

// Delta holds streamed token increments.
type Delta struct {
	Role      *Role           `json:"role,omitempty"`
	Content   *string         `json:"content,omitempty"`
	Reasoning *string         `json:"reasoning,omitempty"`
	ToolCalls []ToolCallDelta `json:"tool_calls,omitempty"`
}

// ChatChunk represents an individual streaming event.
type ChatChunk struct {
	ID           string   `json:"id"`
	Model        string   `json:"model"`
	Provider     string   `json:"provider"`
	Delta        Delta    `json:"delta"`
	FinishReason *string  `json:"finish_reason"`
	Usage        *Usage   `json:"usage,omitempty"`
	CostUSD      *float64 `json:"cost_usd,omitempty"`
}

// EmbeddingRequest specifies input text/tokens for embedding models.
type EmbeddingRequest struct {
	Model string `json:"model"`
	Input any    `json:"input"` // string or []string
}

// EmbeddingData represents an individual vector embedding.
type EmbeddingData struct {
	Index     int       `json:"index"`
	Embedding []float64 `json:"embedding"`
}

// EmbeddingResponse contains the generated vectors and usage stats.
type EmbeddingResponse struct {
	Object   string          `json:"object"`
	Model    string          `json:"model"`
	Provider string          `json:"provider"`
	Data     []EmbeddingData `json:"data"`
	Usage    *Usage          `json:"usage,omitempty"`
}

// RawRequest allows sending raw payload directly to a provider endpoint.
type RawRequest struct {
	RouteID string `json:"routeId"`
	Path    string `json:"path,omitempty"`
	Body    any    `json:"body"`
}

// AttemptEvent is fired on each attempt across routes.
type AttemptEvent struct {
	RouteID  string    `json:"routeId"`
	Provider string    `json:"provider"`
	Model    string    `json:"model"`
	KeyIndex int       `json:"keyIndex"`
	Attempt  int       `json:"attempt"`
	Duration int64     `json:"durationMs"`
	Error    error     `json:"error,omitempty"`
	Kind     ErrorKind `json:"kind,omitempty"`
}

// CallOptions allows customizing execution per call.
type CallOptions struct {
	DeadlineMs int
	OnAttempt  func(event AttemptEvent)
}

// Helper to convert ChatMessage to JSON map or bytes
func ToJSONMap(v any) (map[string]any, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var res map[string]any
	err = json.Unmarshal(b, &res)
	return res, err
}
