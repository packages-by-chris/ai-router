package airouter_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	airouter "github.com/ai-router-sdk/ai-router-go"
)

func normalizeForComparison(val any) any {
	if val == nil {
		return nil
	}
	v := reflect.ValueOf(val)
	if v.Kind() == reflect.Ptr {
		if v.IsNil() {
			return nil
		}
		return normalizeForComparison(v.Elem().Interface())
	}

	switch x := val.(type) {
	case airouter.ChatRequest:
		var m map[string]any
		b, _ := json.Marshal(x)
		_ = json.Unmarshal(b, &m)
		return normalizeForComparison(m)
	case *airouter.ChatRequest:
		var m map[string]any
		b, _ := json.Marshal(x)
		_ = json.Unmarshal(b, &m)
		return normalizeForComparison(m)
	case airouter.ChatResponse:
		var m map[string]any
		b, _ := json.Marshal(x)
		_ = json.Unmarshal(b, &m)
		return normalizeForComparison(m)
	case *airouter.ChatResponse:
		var m map[string]any
		b, _ := json.Marshal(x)
		_ = json.Unmarshal(b, &m)
		return normalizeForComparison(m)
	case airouter.ChatChunk:
		var m map[string]any
		b, _ := json.Marshal(x)
		_ = json.Unmarshal(b, &m)
		return normalizeForComparison(m)
	case *airouter.ChatChunk:
		var m map[string]any
		b, _ := json.Marshal(x)
		_ = json.Unmarshal(b, &m)
		return normalizeForComparison(m)
	case map[string]any:
		out := make(map[string]any)
		for k, v := range x {
			nv := normalizeForComparison(v)
			if nv != nil {
				out[k] = nv
			}
		}
		return out
	case []any:
		var out []any
		for _, item := range x {
			out = append(out, normalizeForComparison(item))
		}
		return out
	case []string:
		var out []any
		for _, item := range x {
			out = append(out, item)
		}
		return out
	default:
		return val
	}
}

func stableJSON(v any) string {
	norm := normalizeForComparison(v)
	b, _ := json.Marshal(norm)
	// Roundtrip through generic map/slice for standard representation
	var generic any
	_ = json.Unmarshal(b, &generic)
	sortedB, _ := json.Marshal(generic)
	return string(sortedB)
}

func runCase(caseMap map[string]any) (any, error) {
	kind, _ := caseMap["kind"].(string)
	providerModel, _ := caseMap["providerModel"].(string)
	stream, _ := caseMap["stream"].(bool)
	label, _ := caseMap["label"].(string)
	if label == "" {
		label = "openai"
	}

	openaiAdapter := airouter.NewOpenAIAdapter(label)
	anthropicAdapter := airouter.NewAnthropicAdapter()
	geminiAdapter := airouter.NewGeminiAdapter()
	bedrockAdapter := airouter.NewBedrockAdapter()

	switch kind {
	case "openai_request":
		reqBytes, _ := json.Marshal(caseMap["request"])
		var req airouter.ChatRequest
		_ = json.Unmarshal(reqBytes, &req)
		return openaiAdapter.TranslateRequest(&req, providerModel, stream)

	case "openai_response":
		respBytes, _ := json.Marshal(caseMap["response"])
		return openaiAdapter.TranslateResponse(respBytes, providerModel)

	case "openai_chunk":
		respBytes, _ := json.Marshal(caseMap["response"])
		return openaiAdapter.TranslateChunk(respBytes, providerModel)

	case "anthropic_request":
		reqBytes, _ := json.Marshal(caseMap["request"])
		var req airouter.ChatRequest
		_ = json.Unmarshal(reqBytes, &req)
		return anthropicAdapter.TranslateRequest(&req, providerModel, stream)

	case "anthropic_response":
		respBytes, _ := json.Marshal(caseMap["response"])
		return anthropicAdapter.TranslateResponse(respBytes, providerModel)

	case "gemini_request":
		reqBytes, _ := json.Marshal(caseMap["request"])
		var req airouter.ChatRequest
		_ = json.Unmarshal(reqBytes, &req)
		return geminiAdapter.TranslateRequest(&req, providerModel, stream)

	case "gemini_response":
		respBytes, _ := json.Marshal(caseMap["response"])
		return geminiAdapter.TranslateResponse(respBytes, providerModel)

	case "bedrock_request":
		reqBytes, _ := json.Marshal(caseMap["request"])
		var req airouter.ChatRequest
		_ = json.Unmarshal(reqBytes, &req)
		return bedrockAdapter.TranslateRequest(&req, providerModel, stream)

	case "bedrock_response":
		respBytes, _ := json.Marshal(caseMap["response"])
		return bedrockAdapter.TranslateResponse(respBytes, providerModel)

	case "sse_parse":
		rawChunks, _ := caseMap["response"].([]any)
		var chunkStrings []string
		for _, c := range rawChunks {
			if s, ok := c.(string); ok {
				chunkStrings = append(chunkStrings, s)
			}
		}
		return airouter.ParseSSEChunks(chunkStrings), nil

	default:
		return nil, nil
	}
}

func TestConformanceFixtures(t *testing.T) {
	casesDir := filepath.Join("..", "core", "conformance", "cases")
	files, err := os.ReadDir(casesDir)
	if err != nil {
		t.Fatalf("failed to read cases dir: %v", err)
	}

	var jsonFiles []string
	for _, f := range files {
		if !f.IsDir() && filepath.Ext(f.Name()) == ".json" {
			jsonFiles = append(jsonFiles, f.Name())
		}
	}
	sort.Strings(jsonFiles)

	for _, fileName := range jsonFiles {
		filePath := filepath.Join(casesDir, fileName)
		dataBytes, err := os.ReadFile(filePath)
		if err != nil {
			t.Fatalf("failed to read file %s: %v", fileName, err)
		}

		var fileJSON map[string]any
		if err := json.Unmarshal(dataBytes, &fileJSON); err != nil {
			t.Fatalf("failed to unmarshal JSON in %s: %v", fileName, err)
		}

		cases, _ := fileJSON["cases"].([]any)
		t.Run(fileName, func(t *testing.T) {
			for _, cVal := range cases {
				cMap, ok := cVal.(map[string]any)
				if !ok {
					continue
				}
				name, _ := cMap["name"].(string)
				expectedVal := cMap["expected"]

				t.Run(name, func(t *testing.T) {
					actual, err := runCase(cMap)
					if err != nil {
						t.Fatalf("error executing case: %v", err)
					}

					expectedJSON := stableJSON(expectedVal)
					actualJSON := stableJSON(actual)

					if expectedJSON != actualJSON {
						t.Errorf("mismatch:\nEXPECTED: %s\nACTUAL:   %s", expectedJSON, actualJSON)
					}
				})
			}
		})
	}
}
