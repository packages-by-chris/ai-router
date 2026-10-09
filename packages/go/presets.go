package airouter

import "sync"

// ProviderPreset configures predefined base URLs and authentication schemas.
type ProviderPreset struct {
	Adapter    string
	BaseURL    string
	Auth       string // "bearer" | "none" | named header
	Headers    map[string]string
	AuthHeader string
}

// Presets maps provider names to their predefined configuration.
var Presets = map[string]ProviderPreset{
	"groq":          {Adapter: "openai-compatible", BaseURL: "https://api.groq.com/openai/v1", Auth: "bearer"},
	"deepseek":      {Adapter: "openai-compatible", BaseURL: "https://api.deepseek.com/v1", Auth: "bearer"},
	"mistral":       {Adapter: "openai-compatible", BaseURL: "https://api.mistral.ai/v1", Auth: "bearer"},
	"openrouter":    {Adapter: "openai-compatible", BaseURL: "https://openrouter.ai/api/v1", Auth: "bearer"},
	"together":      {Adapter: "openai-compatible", BaseURL: "https://api.together.xyz/v1", Auth: "bearer"},
	"fireworks":     {Adapter: "openai-compatible", BaseURL: "https://api.fireworks.ai/inference/v1", Auth: "bearer"},
	"perplexity":    {Adapter: "openai-compatible", BaseURL: "https://api.perplexity.ai", Auth: "bearer"},
	"xai":           {Adapter: "openai-compatible", BaseURL: "https://api.x.ai/v1", Auth: "bearer"},
	"cerebras":      {Adapter: "openai-compatible", BaseURL: "https://api.cerebras.ai/v1", Auth: "bearer"},
	"sambanova":     {Adapter: "openai-compatible", BaseURL: "https://api.sambanova.ai/v1", Auth: "bearer"},
	"cohere":        {Adapter: "openai-compatible", BaseURL: "https://api.cohere.ai/compatibility/v1", Auth: "bearer"},
	"deepinfra":     {Adapter: "openai-compatible", BaseURL: "https://api.deepinfra.com/v1/openai", Auth: "bearer"},
	"nvidia":        {Adapter: "openai-compatible", BaseURL: "https://integrate.api.nvidia.com/v1", Auth: "bearer"},
	"github-models": {Adapter: "openai-compatible", BaseURL: "https://models.github.ai/inference", Auth: "bearer"},
	"hyperbolic":    {Adapter: "openai-compatible", BaseURL: "https://api.hyperbolic.xyz/v1", Auth: "bearer"},
	"novita":        {Adapter: "openai-compatible", BaseURL: "https://api.novita.ai/v3/openai", Auth: "bearer"},
	"nebius":        {Adapter: "openai-compatible", BaseURL: "https://api.studio.nebius.com/v1", Auth: "bearer"},
	"lambda":        {Adapter: "openai-compatible", BaseURL: "https://api.lambda.ai/v1", Auth: "bearer"},
	"moonshot":      {Adapter: "openai-compatible", BaseURL: "https://api.moonshot.cn/v1", Auth: "bearer"},
	"minimax":       {Adapter: "openai-compatible", BaseURL: "https://api.minimax.chat/v1", Auth: "bearer"},
	"siliconflow":   {Adapter: "openai-compatible", BaseURL: "https://api.siliconflow.cn/v1", Auth: "bearer"},
	"ollama":        {Adapter: "openai-compatible", BaseURL: "http://localhost:11434/v1", Auth: "none"},
	"vllm":          {Adapter: "openai-compatible", BaseURL: "http://localhost:8000/v1", Auth: "none"},
	"lmstudio":      {Adapter: "openai-compatible", BaseURL: "http://localhost:1234/v1", Auth: "none"},
}

var (
	registryMu sync.RWMutex
	registry   = map[string]ProviderAdapter{}
)

func init() {
	RegisterAdapter("openai", NewOpenAIAdapter("openai"))
	RegisterAdapter("openai-compatible", NewOpenAIAdapter("openai-compatible"))
	RegisterAdapter("anthropic", NewAnthropicAdapter())
	RegisterAdapter("gemini", NewGeminiAdapter())
	RegisterAdapter("bedrock", NewBedrockAdapter())
	RegisterAdapter("vertex", NewVertexAdapter())
	RegisterAdapter("azure", NewAzureAdapter())
}

// RegisterAdapter registers a custom ProviderAdapter implementation.
func RegisterAdapter(name string, adapter ProviderAdapter) {
	registryMu.Lock()
	defer registryMu.Unlock()
	registry[name] = adapter
}

// GetAdapter returns the ProviderAdapter for a given adapter ID.
func GetAdapter(name string) (ProviderAdapter, bool) {
	registryMu.RLock()
	defer registryMu.RUnlock()
	a, ok := registry[name]
	return a, ok
}
