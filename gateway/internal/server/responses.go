package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"codearts2api/internal/protocol"
)

// handleCodexResponses bridges OpenAI Responses API (/v1/responses) used by Codex CLI & Desktop App
// onto Server.handleChatCompletions so it inherits 100% of CodeArts2API's SigV4 signing,
// account pool failover, rate limiting, and request logging while supporting multi-turn
// function_call + function_call_output history and full Responses SSE tool streaming.
func (s *Server) handleCodexResponses(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error")
		return
	}

	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body", "invalid_request_error")
		return
	}

	model, _ := body["model"].(string)
	model = strings.TrimSpace(model)
	settings := s.Store.Settings()
	if model == "" {
		codexProfile := s.getSwitchProfiles().Codex
		if codexProfile.Model != "" {
			model = codexProfile.Model
		} else {
			model = settings.DefaultModel
		}
	} else if settings.ForceModel == "" {
		// If Codex Desktop sends a built-in OpenAI slug (e.g. gpt-6.2-sol, gpt-5.6-sol) that is not
		// a CodeArts model or explicit alias, transparently route it to the user's selected Codex
		// CodeArts model without requiring global force_model (keeping Claude Code / DSH isolated).
		if _, ok := s.Reg.Resolve(model, settings.ModelAliases); !ok {
			codexProfile := s.getSwitchProfiles().Codex
			if codexProfile.ShouldFallbackUnknownModel() {
				fallback := strings.TrimSpace(codexProfile.Model)
				if fallback == "" {
					fallback = settings.DefaultModel
				}
				if fallback != "" {
					model = fallback
				}
			}
		}
	}
	stream, _ := body["stream"].(bool)

	messages := protocol.SanitizeOpenAIMessages(convertResponsesInputToMessages(body))
	tools := convertResponsesTools(body)

	chatPayload := map[string]any{
		"model":    model,
		"messages": messages,
		"stream":   false,
	}
	if len(tools) > 0 {
		chatPayload["tools"] = tools
	}
	if maxOut, ok := body["max_output_tokens"]; ok {
		chatPayload["max_tokens"] = maxOut
	}
	if temp, ok := body["temperature"]; ok {
		chatPayload["temperature"] = temp
	}

	rawReq, _ := json.Marshal(chatPayload)
	subReq := r.Clone(r.Context())
	subReq.URL.Path = "/v1/chat/completions"
	subReq.Body = io.NopCloser(bytes.NewReader(rawReq))
	subReq.ContentLength = int64(len(rawReq))

	rec := newCaptureResponseWriter()
	s.handleChatCompletions(rec, subReq)

	if rec.status >= 400 {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(rec.status)
		_, _ = w.Write(rec.buf.Bytes())
		return
	}

	var chatResp struct {
		ID      string `json:"id"`
		Model   string `json:"model"`
		Choices []struct {
			Message struct {
				Content   string `json:"content"`
				ToolCalls []struct {
					ID       string `json:"id"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
			TotalTokens      int `json:"total_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(rec.buf.Bytes(), &chatResp); err != nil {
		writeErr(w, http.StatusBadGateway, "上游响应格式解析失败", "api_error")
		return
	}

	content := ""
	type toolCall struct {
		id, name, args string
	}
	var calls []toolCall
	if len(chatResp.Choices) > 0 {
		content = chatResp.Choices[0].Message.Content
		for _, tc := range chatResp.Choices[0].Message.ToolCalls {
			calls = append(calls, toolCall{id: tc.ID, name: tc.Function.Name, args: tc.Function.Arguments})
		}
	}

	respID := "resp_" + strings.TrimPrefix(chatResp.ID, "chatcmpl-")
	createdAt := time.Now().Unix()

	var output []map[string]any
	if content != "" || len(calls) == 0 {
		output = append(output, map[string]any{
			"id":     "msg_" + respID,
			"type":   "message",
			"status": "completed",
			"role":   "assistant",
			"content": []map[string]any{
				{"type": "output_text", "text": content, "annotations": []any{}},
			},
		})
	}
	for _, tc := range calls {
		output = append(output, map[string]any{
			"id":        "fc_" + tc.id,
			"type":      "function_call",
			"status":    "completed",
			"call_id":   tc.id,
			"name":      tc.name,
			"arguments": tc.args,
		})
	}

	finalObj := map[string]any{
		"id":          respID,
		"object":      "response",
		"created_at":  createdAt,
		"status":      "completed",
		"model":       chatResp.Model,
		"output":      output,
		"output_text": content,
		"usage": map[string]int{
			"input_tokens":  chatResp.Usage.PromptTokens,
			"output_tokens": chatResp.Usage.CompletionTokens,
			"total_tokens":  chatResp.Usage.TotalTokens,
		},
	}

	if !stream {
		writeJSON(w, http.StatusOK, finalObj)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher, _ := w.(http.Flusher)

	emit := func(event string, payload map[string]any) {
		payload["type"] = event
		b, _ := json.Marshal(payload)
		_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, string(b))
		if flusher != nil {
			flusher.Flush()
		}
	}

	emit("response.created", map[string]any{
		"response": map[string]any{
			"id": respID, "object": "response", "created_at": createdAt,
			"status": "in_progress", "model": chatResp.Model, "output": []any{},
		},
	})

	outIdx := 0
	if content != "" || len(calls) == 0 {
		msgID := "msg_" + respID
		emit("response.output_item.added", map[string]any{
			"output_index": outIdx,
			"item":         map[string]any{"id": msgID, "type": "message", "status": "in_progress", "role": "assistant", "content": []any{}},
		})
		emit("response.content_part.added", map[string]any{
			"item_id": msgID, "output_index": outIdx, "content_index": 0,
			"part": map[string]any{"type": "output_text", "text": "", "annotations": []any{}},
		})
		if content != "" {
			emit("response.output_text.delta", map[string]any{
				"item_id": msgID, "output_index": outIdx, "content_index": 0, "delta": content,
			})
		}
		emit("response.output_text.done", map[string]any{
			"item_id": msgID, "output_index": outIdx, "content_index": 0, "text": content,
		})
		emit("response.output_item.done", map[string]any{
			"output_index": outIdx,
			"item": map[string]any{
				"id": msgID, "type": "message", "status": "completed", "role": "assistant",
				"content": []map[string]any{{"type": "output_text", "text": content, "annotations": []any{}}},
			},
		})
		outIdx++
	}

	for _, tc := range calls {
		fcID := "fc_" + tc.id
		emit("response.output_item.added", map[string]any{
			"output_index": outIdx,
			"item": map[string]any{
				"id": fcID, "type": "function_call", "status": "in_progress",
				"call_id": tc.id, "name": tc.name, "arguments": "",
			},
		})
		if tc.args != "" {
			emit("response.function_call_arguments.delta", map[string]any{
				"item_id": fcID, "output_index": outIdx, "delta": tc.args,
			})
		}
		emit("response.function_call_arguments.done", map[string]any{
			"item_id": fcID, "output_index": outIdx, "arguments": tc.args,
		})
		emit("response.output_item.done", map[string]any{
			"output_index": outIdx,
			"item": map[string]any{
				"id": fcID, "type": "function_call", "status": "completed",
				"call_id": tc.id, "name": tc.name, "arguments": tc.args,
			},
		})
		outIdx++
	}

	emit("response.completed", map[string]any{"response": finalObj})
}

func convertResponsesInputToMessages(body map[string]any) []map[string]any {
	var messages []map[string]any
	if inst, ok := body["instructions"].(string); ok && strings.TrimSpace(inst) != "" {
		messages = append(messages, map[string]any{"role": "system", "content": strings.TrimSpace(inst)})
	}
	if text, ok := body["input"].(string); ok && strings.TrimSpace(text) != "" {
		messages = append(messages, map[string]any{"role": "user", "content": strings.TrimSpace(text)})
		return messages
	}
	items, ok := body["input"].([]any)
	if !ok {
		return messages
	}

	var pendingCalls []map[string]any
	flushCalls := func() {
		if len(pendingCalls) == 0 {
			return
		}
		if len(messages) > 0 && messages[len(messages)-1]["role"] == "assistant" {
			existing, _ := messages[len(messages)-1]["tool_calls"].([]map[string]any)
			messages[len(messages)-1]["tool_calls"] = append(existing, pendingCalls...)
		} else {
			messages = append(messages, map[string]any{
				"role":       "assistant",
				"content":    "",
				"tool_calls": pendingCalls,
			})
		}
		pendingCalls = nil
	}

	for _, raw := range items {
		if s, ok := raw.(string); ok {
			flushCalls()
			messages = append(messages, map[string]any{"role": "user", "content": s})
			continue
		}
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		typ, _ := m["type"].(string)
		if typ == "reasoning" {
			continue
		}
		if typ == "function_call" {
			name, _ := m["name"].(string)
			callID, _ := m["call_id"].(string)
			args, _ := m["arguments"].(string)
			if name != "" {
				pendingCalls = append(pendingCalls, map[string]any{
					"id":   callID,
					"type": "function",
					"function": map[string]any{
						"name":      name,
						"arguments": args,
					},
				})
			}
			continue
		}
		flushCalls()
		if typ == "function_call_output" {
			callID, _ := m["call_id"].(string)
			outStr, _ := m["output"].(string)
			messages = append(messages, map[string]any{
				"role":         "tool",
				"tool_call_id": callID,
				"content":      outStr,
			})
			continue
		}
		role, _ := m["role"].(string)
		if role == "developer" {
			role = "system"
		} else if role != "system" && role != "assistant" {
			role = "user"
		}
		text := extractAnyText(m["content"])
		if text != "" {
			messages = append(messages, map[string]any{"role": role, "content": text})
		}
	}
	flushCalls()
	return messages
}

func convertResponsesTools(body map[string]any) []map[string]any {
	rawTools, ok := body["tools"].([]any)
	if !ok {
		return nil
	}
	var out []map[string]any
	for _, rt := range rawTools {
		m, ok := rt.(map[string]any)
		if !ok {
			continue
		}
		if m["type"] == "function" {
			name, _ := m["name"].(string)
			if name == "" {
				continue
			}
			fn := map[string]any{"name": name}
			if desc, ok := m["description"].(string); ok {
				fn["description"] = desc
			}
			if params, ok := m["parameters"]; ok {
				fn["parameters"] = params
			}
			out = append(out, map[string]any{"type": "function", "function": fn})
		}
	}
	return out
}

func extractAnyText(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	if arr, ok := v.([]any); ok {
		var parts []string
		for _, it := range arr {
			if m, ok := it.(map[string]any); ok {
				if t, ok := m["text"].(string); ok && t != "" {
					parts = append(parts, t)
				}
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

type captureResponseWriter struct {
	header http.Header
	status int
	buf    bytes.Buffer
}

func newCaptureResponseWriter() *captureResponseWriter {
	return &captureResponseWriter{header: make(http.Header), status: http.StatusOK}
}

func (c *captureResponseWriter) Header() http.Header         { return c.header }
func (c *captureResponseWriter) WriteHeader(code int)        { c.status = code }
func (c *captureResponseWriter) Write(p []byte) (int, error) { return c.buf.Write(p) }
