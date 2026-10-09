package airouter

import (
	"bufio"
	"bytes"
	"io"
	"strings"
)

// ParseSSE parses an SSE byte stream and yields data payloads.
func ParseSSE(r io.Reader) <-chan string {
	out := make(chan string, 100)
	go func() {
		defer close(out)
		scanner := bufio.NewScanner(r)
		// Custom split function handling both CRLF and LF
		scanner.Split(func(data []byte, atEOF bool) (advance int, token []byte, err error) {
			if atEOF && len(data) == 0 {
				return 0, nil, nil
			}
			if i := bytes.Index(data, []byte("\r\n\r\n")); i >= 0 {
				return i + 4, data[0:i], nil
			}
			if i := bytes.Index(data, []byte("\n\n")); i >= 0 {
				return i + 2, data[0:i], nil
			}
			if i := bytes.Index(data, []byte("\r\n")); i >= 0 {
				// Single line
			}
			if atEOF {
				return len(data), data, nil
			}
			return 0, nil, nil
		})

		var buffer string
		bufReader := bufio.NewReader(r)

		var curDataLines []string
		for {
			line, err := bufReader.ReadString('\n')
			trimmed := strings.TrimRight(line, "\r\n")

			if strings.HasPrefix(trimmed, ":") {
				// SSE comment, ignore
			} else if strings.HasPrefix(trimmed, "data:") {
				val := strings.TrimPrefix(trimmed, "data:")
				val = strings.TrimPrefix(val, " ")
				curDataLines = append(curDataLines, val)
			} else if trimmed == "" {
				if len(curDataLines) > 0 {
					payload := strings.Join(curDataLines, "\n")
					out <- payload
					curDataLines = nil
				}
			}

			if err != nil {
				if len(curDataLines) > 0 {
					payload := strings.Join(curDataLines, "\n")
					out <- payload
				}
				break
			}
		}
		_ = buffer
	}()
	return out
}

// ParseSSEChunks processes raw chunk fragments and returns completed data payloads.
func ParseSSEChunks(chunks []string) []string {
	var results []string
	var curDataLines []string

	full := strings.Join(chunks, "")
	lines := strings.Split(full, "\n")
	for _, l := range lines {
		trimmed := strings.TrimRight(l, "\r")
		if strings.HasPrefix(trimmed, ":") {
			continue
		}
		if strings.HasPrefix(trimmed, "data:") {
			val := strings.TrimPrefix(trimmed, "data:")
			val = strings.TrimPrefix(val, " ")
			curDataLines = append(curDataLines, val)
		} else if trimmed == "" {
			if len(curDataLines) > 0 {
				results = append(results, strings.Join(curDataLines, "\n"))
				curDataLines = nil
			}
		}
	}
	if len(curDataLines) > 0 {
		results = append(results, strings.Join(curDataLines, "\n"))
	}
	return results
}
