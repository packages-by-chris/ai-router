package airouter

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
)

// RoutingStrategy defines ordering policy across candidate routes.
type RoutingStrategy string

const (
	StrategyFallback     RoutingStrategy = "fallback"
	StrategyRoundRobin   RoutingStrategy = "round-robin"
	StrategyWeighted     RoutingStrategy = "weighted"
	StrategyLeastLatency RoutingStrategy = "least-latency"
	StrategyCheapest     RoutingStrategy = "cheapest"
	StrategyBalanced     RoutingStrategy = "balanced"
	StrategyQualityFirst RoutingStrategy = "quality-first"
)

// LimitRule specifies RPM and TPM rate limits.
type LimitRule struct {
	RPM int `json:"rpm,omitempty"`
	TPM int `json:"tpm,omitempty"`
}

// BudgetRule defines spend limits over a time window.
type BudgetRule struct {
	USD      float64 `json:"usd"`
	WindowMs int64   `json:"windowMs"`
}

// Capabilities declares supported features of a route's model.
type Capabilities struct {
	Streaming        *bool `json:"streaming,omitempty"`
	Tools            *bool `json:"tools,omitempty"`
	Vision           *bool `json:"vision,omitempty"`
	JSON             *bool `json:"json,omitempty"`
	StructuredOutput *bool `json:"structuredOutput,omitempty"`
	Reasoning        *bool `json:"reasoning,omitempty"`
	Audio            *bool `json:"audio,omitempty"`
	Embeddings       *bool `json:"embeddings,omitempty"`
	Multimodal       *bool `json:"multimodal,omitempty"`
	LongContext      *bool `json:"longContext,omitempty"`
	ContextWindow    int   `json:"contextWindow,omitempty"`
}

// ModelRoute specifies a single backend route definition.
type ModelRoute struct {
	ID                 string            `json:"id"`
	Provider           string            `json:"provider"`
	Model              string            `json:"model"`
	APIKey             string            `json:"apiKey,omitempty"`
	APIKeys            []string          `json:"apiKeys,omitempty"`
	BaseURL            string            `json:"baseUrl,omitempty"`
	APIVersion         string            `json:"apiVersion,omitempty"`
	Region             string            `json:"region,omitempty"`
	Project            string            `json:"project,omitempty"`
	Headers            map[string]string `json:"headers,omitempty"`
	MaxRetries         *int              `json:"maxRetries,omitempty"`
	TimeoutMs          *int              `json:"timeoutMs,omitempty"`
	StreamIdleTimeoutMs *int              `json:"streamIdleTimeoutMs,omitempty"`
	Limit              *LimitRule        `json:"limit,omitempty"`
	Budget             *BudgetRule       `json:"budget,omitempty"`
	Weight             *int              `json:"weight,omitempty"`
	Capabilities       *Capabilities     `json:"capabilities,omitempty"`
	Pricing            *TokenPrice       `json:"pricing,omitempty"`
}

// PolicyWeights configures multi-objective scoring balance.
type PolicyWeights struct {
	Cost        *float64 `json:"cost,omitempty"`
	Speed       *float64 `json:"speed,omitempty"`
	Reliability *float64 `json:"reliability,omitempty"`
}

// RouterConfig represents the top-level configuration.
type RouterConfig struct {
	Routes   []ModelRoute     `json:"routes"`
	Strategy RoutingStrategy  `json:"strategy,omitempty"`
	Weights  *PolicyWeights   `json:"weights,omitempty"`
}

var envPattern = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`)

func interpolateEnv(val any, env map[string]string, path string) (any, error) {
	switch v := val.(type) {
	case string:
		if !strings.Contains(v, "${") {
			return v, nil
		}
		var interpErr error
		res := envPattern.ReplaceAllStringFunc(v, func(match string) string {
			if interpErr != nil {
				return match
			}
			varName := match[2 : len(match)-1]
			resolved, ok := env[varName]
			if !ok {
				interpErr = &ConfigError{Message: fmt.Sprintf("%s: environment variable %q is not set", path, varName)}
				return match
			}
			return resolved
		})
		if interpErr != nil {
			return nil, interpErr
		}
		return res, nil
	case []any:
		res := make([]any, len(v))
		for i, elem := range v {
			interpElem, err := interpolateEnv(elem, env, fmt.Sprintf("%s[%d]", path, i))
			if err != nil {
				return nil, err
			}
			res[i] = interpElem
		}
		return res, nil
	case map[string]any:
		res := make(map[string]any, len(v))
		for k, elem := range v {
			interpElem, err := interpolateEnv(elem, env, fmt.Sprintf("%s.%s", path, k))
			if err != nil {
				return nil, err
			}
			res[k] = interpElem
		}
		return res, nil
	default:
		return v, nil
	}
}

var (
	validStrategies = map[RoutingStrategy]bool{
		StrategyFallback:     true,
		StrategyRoundRobin:   true,
		StrategyWeighted:     true,
		StrategyLeastLatency: true,
		StrategyCheapest:     true,
		StrategyBalanced:     true,
		StrategyQualityFirst: true,
	}
)

// ParseConfig parses, validates, and interpolates ${ENV_VAR} in config map/struct/JSON.
func ParseConfig(input any, customEnv ...map[string]string) (*RouterConfig, error) {
	env := make(map[string]string)
	for _, envPair := range os.Environ() {
		parts := strings.SplitN(envPair, "=", 2)
		if len(parts) == 2 {
			env[parts[0]] = parts[1]
		}
	}
	if len(customEnv) > 0 && customEnv[0] != nil {
		for k, v := range customEnv[0] {
			env[k] = v
		}
	}

	// Normalize input to generic map[string]any
	var rawMap map[string]any
	switch v := input.(type) {
	case string:
		if err := json.Unmarshal([]byte(v), &rawMap); err != nil {
			return nil, &ConfigError{Message: fmt.Sprintf("invalid JSON input: %v", err)}
		}
	case []byte:
		if err := json.Unmarshal(v, &rawMap); err != nil {
			return nil, &ConfigError{Message: fmt.Sprintf("invalid JSON input: %v", err)}
		}
	case map[string]any:
		rawMap = v
	default:
		b, err := json.Marshal(input)
		if err != nil {
			return nil, &ConfigError{Message: fmt.Sprintf("failed to marshal input: %v", err)}
		}
		if err := json.Unmarshal(b, &rawMap); err != nil {
			return nil, &ConfigError{Message: fmt.Sprintf("failed to unmarshal input: %v", err)}
		}
	}

	if rawMap == nil {
		return nil, &ConfigError{Message: "config: expected an object"}
	}

	interpolated, err := interpolateEnv(rawMap, env, "config")
	if err != nil {
		return nil, err
	}

	interpMap, ok := interpolated.(map[string]any)
	if !ok {
		return nil, &ConfigError{Message: "config: expected an object"}
	}

	var errors []string

	// Validate routes array
	routesRaw, ok := interpMap["routes"]
	if !ok {
		errors = append(errors, "config.routes: must not be empty")
	} else if routesList, ok := routesRaw.([]any); !ok {
		errors = append(errors, "config.routes: expected an array")
	} else if len(routesList) == 0 {
		errors = append(errors, "config.routes: must not be empty")
	}

	// Validate strategy
	var strategy RoutingStrategy = StrategyFallback
	if stratRaw, ok := interpMap["strategy"]; ok {
		if s, ok := stratRaw.(string); ok {
			strategy = RoutingStrategy(s)
			if !validStrategies[strategy] {
				errors = append(errors, fmt.Sprintf("config.strategy: invalid strategy %q", s))
			}
		} else {
			errors = append(errors, "config.strategy: expected a string")
		}
	}

	if len(errors) > 0 {
		sort.Strings(errors)
		return nil, &ConfigError{Message: strings.Join(errors, "\n")}
	}

	// Marshal and unmarshal to strong RouterConfig struct
	b, err := json.Marshal(interpMap)
	if err != nil {
		return nil, &ConfigError{Message: err.Error()}
	}

	var config RouterConfig
	if err := json.Unmarshal(b, &config); err != nil {
		return nil, &ConfigError{Message: err.Error()}
	}

	if config.Strategy == "" {
		config.Strategy = StrategyFallback
	}

	// Route ID uniqueness check & normalization
	seenIDs := make(map[string]bool)
	for i, r := range config.Routes {
		if r.ID == "" {
			errors = append(errors, fmt.Sprintf("config.routes[%d].id: must not be empty", i))
		} else if seenIDs[r.ID] {
			errors = append(errors, fmt.Sprintf("config.routes[%d].id: duplicate route id %q", i, r.ID))
		} else {
			seenIDs[r.ID] = true
		}

		if r.Provider == "" {
			errors = append(errors, fmt.Sprintf("config.routes[%d].provider: must not be empty", i))
		}
		if r.Model == "" {
			errors = append(errors, fmt.Sprintf("config.routes[%d].model: must not be empty", i))
		}
		if len(r.APIKeys) == 0 && r.APIKey != "" {
			config.Routes[i].APIKeys = []string{r.APIKey}
		}
	}

	if len(errors) > 0 {
		sort.Strings(errors)
		return nil, &ConfigError{Message: strings.Join(errors, "\n")}
	}

	return &config, nil
}
