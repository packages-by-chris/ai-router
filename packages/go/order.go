package airouter

import (
	"sort"
)

// FilterByCapabilities rejects candidate routes lacking requested features.
func FilterByCapabilities(routes []*NormalizedRoute, req *ChatRequest) ([]*NormalizedRoute, []string) {
	var admitted []*NormalizedRoute
	var rejectedReasons []string

	requiresTools := len(req.Tools) > 0 && req.ToolChoice != "none"
	requiresVision := false
	for _, m := range req.Messages {
		if list, ok := m.Content.([]any); ok {
			for _, p := range list {
				if cp, ok := p.(ContentPart); ok && cp.Type == "image_url" {
					requiresVision = true
					break
				}
				if pMap, ok := p.(map[string]any); ok && pMap["type"] == "image_url" {
					requiresVision = true
					break
				}
			}
		}
	}

	for _, r := range routes {
		if requiresTools && r.Capabilities != nil && r.Capabilities.Tools != nil && !*r.Capabilities.Tools {
			rejectedReasons = append(rejectedReasons, r.ID+": model does not support tools")
			continue
		}
		if requiresVision && r.Capabilities != nil && r.Capabilities.Vision != nil && !*r.Capabilities.Vision {
			rejectedReasons = append(rejectedReasons, r.ID+": model does not support vision")
			continue
		}
		admitted = append(admitted, r)
	}

	return admitted, rejectedReasons
}

// OrderCandidates sorts routes according to the configured routing strategy.
func OrderCandidates(routes []*NormalizedRoute, strategy RoutingStrategy, weights *PolicyWeights, health *HealthTracker, req *ChatRequest) []*NormalizedRoute {
	if len(routes) <= 1 {
		return routes
	}

	ordered := make([]*NormalizedRoute, len(routes))
	copy(ordered, routes)

	switch strategy {
	case StrategyCheapest:
		sort.SliceStable(ordered, func(i, j int) bool {
			pI := 0.0
			pJ := 0.0
			if ordered[i].Pricing != nil {
				pI = ordered[i].Pricing.Input + ordered[i].Pricing.Output
			}
			if ordered[j].Pricing != nil {
				pJ = ordered[j].Pricing.Input + ordered[j].Pricing.Output
			}
			return pI < pJ
		})
	case StrategyLeastLatency:
		sort.SliceStable(ordered, func(i, j int) bool {
			snapI := health.Snapshot(ordered[i].ID, len(ordered[i].APIKeys))
			snapJ := health.Snapshot(ordered[j].ID, len(ordered[j].APIKeys))
			latI := 999999.0
			latJ := 999999.0
			if snapI.P50LatencyMs != nil {
				latI = *snapI.P50LatencyMs
			}
			if snapJ.P50LatencyMs != nil {
				latJ = *snapJ.P50LatencyMs
			}
			return latI < latJ
		})
	case StrategyQualityFirst:
		sort.SliceStable(ordered, func(i, j int) bool {
			snapI := health.Snapshot(ordered[i].ID, len(ordered[i].APIKeys))
			snapJ := health.Snapshot(ordered[j].ID, len(ordered[j].APIKeys))
			lbI := 0.5
			lbJ := 0.5
			if snapI.SuccessLB != nil {
				lbI = *snapI.SuccessLB
			}
			if snapJ.SuccessLB != nil {
				lbJ = *snapJ.SuccessLB
			}
			return lbI > lbJ
		})
	case StrategyFallback:
		fallthrough
	default:
		// Preserves configured route order
	}

	return ordered
}
