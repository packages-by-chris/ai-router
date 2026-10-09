package airouter

import (
	"context"
	"strings"
)

// StreamText collects all streamed content deltas into a single text string.
func StreamText(ctx context.Context, chunks <-chan ChatChunk, errs <-chan error) (string, error) {
	var sb strings.Builder
	for {
		select {
		case <-ctx.Done():
			return sb.String(), ctx.Err()
		case err, ok := <-errs:
			if ok && err != nil {
				return sb.String(), err
			}
		case chunk, ok := <-chunks:
			if !ok {
				return sb.String(), nil
			}
			if chunk.Delta.Content != nil {
				sb.WriteString(*chunk.Delta.Content)
			}
		}
	}
}

// CollectStream gathers all streamed chunks into a slice.
func CollectStream(ctx context.Context, chunks <-chan ChatChunk, errs <-chan error) ([]ChatChunk, error) {
	var res []ChatChunk
	for {
		select {
		case <-ctx.Done():
			return res, ctx.Err()
		case err, ok := <-errs:
			if ok && err != nil {
				return res, err
			}
		case chunk, ok := <-chunks:
			if !ok {
				return res, nil
			}
			res = append(res, chunk)
		}
	}
}
