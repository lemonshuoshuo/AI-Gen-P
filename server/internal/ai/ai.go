// Package ai is a minimal client for OpenAI-compatible Chat Completions
// endpoints (DeepSeek, 通义千问, Kimi, 智谱, Ollama, LM Studio, vLLM …).
package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// ErrDisabled is returned when no model is configured.
var ErrDisabled = errors.New("ai not configured")

// Client calls {BaseURL}/chat/completions.
type Client struct {
	baseURL string
	apiKey  string
	model   string
	http    *http.Client
}

// New creates a client; it is disabled unless both baseURL and model are set.
func New(baseURL, apiKey, model string, timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		model:   model,
		http:    &http.Client{Timeout: timeout},
	}
}

// Enabled reports whether the client is configured.
func (c *Client) Enabled() bool { return c != nil && c.baseURL != "" && c.model != "" }

// Message is a chat message.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model          string          `json:"model"`
	Messages       []Message       `json:"messages"`
	Temperature    float64         `json:"temperature"`
	ResponseFormat *responseFormat `json:"response_format,omitempty"`
	Stream         bool            `json:"stream"`
}

type responseFormat struct {
	Type string `json:"type"`
}

type chatResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// HTTPError is a non-2xx response from the model server.
type HTTPError struct {
	Status int
	Body   string
}

func (e *HTTPError) Error() string { return fmt.Sprintf("ai http %d: %s", e.Status, e.Body) }

// Chat sends messages and returns the assistant text. When jsonMode is set it
// asks for response_format=json_object and transparently retries without it
// if the server rejects the parameter.
func (c *Client) Chat(ctx context.Context, msgs []Message, jsonMode bool) (string, error) {
	if !c.Enabled() {
		return "", ErrDisabled
	}
	req := chatRequest{Model: c.model, Messages: msgs, Temperature: 0.4}
	if jsonMode {
		req.ResponseFormat = &responseFormat{Type: "json_object"}
	}
	text, err := c.do(ctx, req)
	var he *HTTPError
	if jsonMode && errors.As(err, &he) && (he.Status == http.StatusBadRequest || he.Status == http.StatusUnprocessableEntity) {
		req.ResponseFormat = nil
		text, err = c.do(ctx, req)
	}
	return text, err
}

func (c *Client) do(ctx context.Context, body chatRequest) (string, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(b))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		msg := string(data)
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return "", &HTTPError{Status: resp.StatusCode, Body: msg}
	}
	var cr chatResponse
	if err := json.Unmarshal(data, &cr); err != nil {
		return "", fmt.Errorf("ai decode: %w", err)
	}
	if cr.Error != nil {
		return "", fmt.Errorf("ai error: %s", cr.Error.Message)
	}
	if len(cr.Choices) == 0 {
		return "", errors.New("ai: empty choices")
	}
	return cr.Choices[0].Message.Content, nil
}

// ChatJSON asks for a JSON answer and decodes it into out, tolerating models
// that wrap JSON in prose, markdown fences or <think> blocks.
func (c *Client) ChatJSON(ctx context.Context, system, user string, out any) error {
	text, err := c.Chat(ctx, []Message{{Role: "system", Content: system}, {Role: "user", Content: user}}, true)
	if err != nil {
		return err
	}
	js, err := ExtractJSON(text)
	if err != nil {
		return err
	}
	if err := json.Unmarshal([]byte(js), out); err != nil {
		return fmt.Errorf("ai json: %w", err)
	}
	return nil
}

var thinkRe = regexp.MustCompile(`(?s)<think>.*?</think>`)

// ErrNoJSON is returned when no JSON object can be found in a model reply.
var ErrNoJSON = errors.New("ai: no JSON object in reply")

// ExtractJSON returns the first complete JSON object in s. It strips
// reasoning blocks (<think>…</think>) and markdown code fences, and matches
// braces while respecting string literals.
func ExtractJSON(s string) (string, error) {
	s = thinkRe.ReplaceAllString(s, "")
	// Prefer the content of a ```json fence when present.
	if i := strings.Index(s, "```"); i >= 0 {
		rest := s[i+3:]
		if nl := strings.IndexByte(rest, '\n'); nl >= 0 {
			body := rest[nl+1:]
			if j := strings.Index(body, "```"); j >= 0 {
				if js, err := firstObject(body[:j]); err == nil {
					return js, nil
				}
			}
		}
	}
	return firstObject(s)
}

func firstObject(s string) (string, error) {
	for start := strings.IndexByte(s, '{'); start >= 0; {
		depth, inStr, esc := 0, false, false
		for i := start; i < len(s); i++ {
			ch := s[i]
			if inStr {
				switch {
				case esc:
					esc = false
				case ch == '\\':
					esc = true
				case ch == '"':
					inStr = false
				}
				continue
			}
			switch ch {
			case '"':
				inStr = true
			case '{':
				depth++
			case '}':
				depth--
				if depth == 0 {
					cand := s[start : i+1]
					if json.Valid([]byte(cand)) {
						return cand, nil
					}
					i = len(s) // give up on this start; try the next '{'
				}
			}
		}
		next := strings.IndexByte(s[start+1:], '{')
		if next < 0 {
			break
		}
		start += 1 + next
	}
	return "", ErrNoJSON
}
