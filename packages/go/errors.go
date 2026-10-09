package airouter

import (
	"fmt"
	"strings"
)

// ErrorKind classifies errors for recovery layers.
type ErrorKind string

const (
	ErrorKindRateLimit      ErrorKind = "rate_limit"
	ErrorKindAuth           ErrorKind = "auth"
	ErrorKindPermission     ErrorKind = "permission"
	ErrorKindNotFound       ErrorKind = "not_found"
	ErrorKindInvalidRequest ErrorKind = "invalid_request"
	ErrorKindServer         ErrorKind = "server"
	ErrorKindNetwork        ErrorKind = "network"
	ErrorKindTimeout        ErrorKind = "timeout"
	ErrorKindUnknown        ErrorKind = "unknown"
)

// AIRouterError is the base error interface/type for all AI router errors.
type AIRouterError struct {
	Message string
}

func (e *AIRouterError) Error() string {
	return e.Message
}

// ConfigError represents validation or configuration syntax failures.
type ConfigError struct {
	Message string
}

func (e *ConfigError) Error() string {
	return e.Message
}

// UnsupportedProviderError indicates an unknown provider name.
type UnsupportedProviderError struct {
	Provider string
}

func (e *UnsupportedProviderError) Error() string {
	return fmt.Sprintf("unsupported provider: %s", e.Provider)
}

// DeadlineExceededError is returned when a call exceeds its deadline.
type DeadlineExceededError struct {
	DeadlineMs int
}

func (e *DeadlineExceededError) Error() string {
	return fmt.Sprintf("call exceeded its %dms deadline", e.DeadlineMs)
}

// RateLimitedError is returned when rate limits are exhausted.
type RateLimitedError struct {
	RouteID      string
	RetryAfterMs int
}

func (e *RateLimitedError) Error() string {
	return fmt.Sprintf("route %q is rate-limited (retry after %dms)", e.RouteID, e.RetryAfterMs)
}

// GuardrailBlockedError is returned when an input guardrail blocks execution.
type GuardrailBlockedError struct {
	GuardrailName string
	Reason        string
}

func (e *GuardrailBlockedError) Error() string {
	return fmt.Sprintf("guardrail %q blocked request: %s", e.GuardrailName, e.Reason)
}

// ProviderError represents a failure from a specific upstream provider.
type ProviderError struct {
	Provider     string
	Kind         ErrorKind
	Message      string
	Status       int
	RetryAfterMs int
	Body         any
}

func (e *ProviderError) Error() string {
	if e.Status > 0 {
		return fmt.Sprintf("[%s] %s (HTTP %d): %s", e.Provider, e.Kind, e.Status, e.Message)
	}
	return fmt.Sprintf("[%s] %s: %s", e.Provider, e.Kind, e.Message)
}

// AttemptRecord logs attempt details across fallback candidates.
type AttemptRecord struct {
	RouteID      string    `json:"routeId"`
	Provider     string    `json:"provider"`
	Model        string    `json:"model"`
	Outcome      string    `json:"outcome"`
	Attempts     int       `json:"attempts"`
	KeyIndex     *int      `json:"keyIndex,omitempty"`
	Kind         ErrorKind `json:"kind,omitempty"`
	Message      string    `json:"message,omitempty"`
	RetryAfterMs int       `json:"retryAfterMs,omitempty"`
}

// AllRoutesFailedError summarizes failure across all candidate routes.
type AllRoutesFailedError struct {
	Message      string
	Attempts     []AttemptRecord
	RetryAfterMs int
}

func (e *AllRoutesFailedError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	var lines []string
	lines = append(lines, fmt.Sprintf("all %d routes failed:", len(e.Attempts)))
	for _, a := range e.Attempts {
		var detail string
		if a.Kind != "" {
			detail = string(a.Kind)
		} else {
			detail = a.Outcome
		}
		if a.Message != "" {
			detail += ": " + a.Message
		}
		lines = append(lines, fmt.Sprintf("  - [%s] %s (%s) -> %s", a.RouteID, a.Provider, a.Model, detail))
	}
	return strings.Join(lines, "\n")
}

// IsRetryableKind returns true if the error kind is transient.
func IsRetryableKind(kind ErrorKind) bool {
	switch kind {
	case ErrorKindRateLimit, ErrorKindServer, ErrorKindNetwork, ErrorKindTimeout:
		return true
	default:
		return false
	}
}

// IsKeyRelatedKind returns true if rotating API key could resolve the issue.
func IsKeyRelatedKind(kind ErrorKind) bool {
	switch kind {
	case ErrorKindAuth, ErrorKindPermission, ErrorKindRateLimit:
		return true
	default:
		return false
	}
}

// ClassifyStatus converts an HTTP status code to an ErrorKind.
func ClassifyStatus(status int) ErrorKind {
	switch status {
	case 401:
		return ErrorKindAuth
	case 403:
		return ErrorKindPermission
	case 404:
		return ErrorKindNotFound
	case 429:
		return ErrorKindRateLimit
	default:
		if status >= 400 && status < 500 {
			return ErrorKindInvalidRequest
		}
		if status >= 500 && status < 600 {
			return ErrorKindServer
		}
		return ErrorKindUnknown
	}
}
