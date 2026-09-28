// Package ai is a minimal client for OpenAI-compatible Chat Completions
// endpoints (DeepSeek, 通义千问, Kimi, 智谱, Ollama, LM Studio, vLLM …).
package ai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	"triphub/internal/netdiag"
)

// ErrDisabled is returned when no model is configured.
var ErrDisabled = errors.New("ai not configured")

// DefaultTimeout bounds a call whose context has no deadline.
const DefaultTimeout = 120 * time.Second

// Thinking modes (TRIPHUB_AI_THINKING).
const (
	ThinkingOff  = "off"  // ask the provider to answer without reasoning (fast)
	ThinkingOn   = "on"   // the provider's reasoning mode, default effort
	ThinkingLow  = "low"  // reasoning with reasoning_effort=low (DeepSeek)
	ThinkingHigh = "high" // reasoning with reasoning_effort=high (DeepSeek)
	ThinkingMax  = "max"  // reasoning with reasoning_effort=max (DeepSeek)
)

// Config configures a Client.
type Config struct {
	// BaseURL is the API base (https://api.deepseek.com, …/v1) or the full
	// …/chat/completions URL; see NormalizeBaseURL.
	BaseURL string
	APIKey  string
	Model   string
	// Timeout bounds calls whose context has no deadline (DefaultTimeout if 0).
	Timeout time.Duration
	// Thinking is one of the Thinking* modes; "" means off.
	Thinking string
	// ExtraBody is merged into every request body, overriding the fields the
	// client sets itself (except model, messages and stream).
	ExtraBody map[string]any
}

// Client calls {BaseURL}/chat/completions.
type Client struct {
	baseURL  string // normalised base, for display
	endpoint string // …/chat/completions
	apiKey   string
	model    string
	timeout  time.Duration
	thinking string
	extra    map[string]any
	http     *http.Client
}

// New creates a client with thinking off; it is disabled unless both baseURL
// and model are set.
func New(baseURL, apiKey, model string, timeout time.Duration) *Client {
	return NewClient(Config{BaseURL: baseURL, APIKey: apiKey, Model: model, Timeout: timeout})
}

// NewClient creates a client from cfg; it is disabled unless both the base
// URL and the model are set.
func NewClient(cfg Config) *Client {
	if cfg.Timeout <= 0 {
		cfg.Timeout = DefaultTimeout
	}
	base, endpoint := NormalizeBaseURL(cfg.BaseURL)
	thinking := strings.ToLower(strings.TrimSpace(cfg.Thinking))
	if thinking == "" {
		thinking = ThinkingOff
	}
	return &Client{
		baseURL:  base,
		endpoint: endpoint,
		apiKey:   strings.TrimSpace(cfg.APIKey),
		model:    strings.TrimSpace(cfg.Model),
		timeout:  cfg.Timeout,
		thinking: thinking,
		extra:    cfg.ExtraBody,
		// No client timeout: a streamed answer may take minutes. Every call
		// runs under a context deadline instead (see withDeadline).
		http: &http.Client{},
	}
}

// NormalizeBaseURL accepts https://api.deepseek.com, …/v1, trailing slashes
// or a full …/chat/completions URL (a missing scheme means https) and
// returns the base URL and the chat completions endpoint.
func NormalizeBaseURL(raw string) (base, endpoint string) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", ""
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	s = strings.TrimRight(s, "/")
	if strings.HasSuffix(strings.ToLower(s), "/chat/completions") {
		base = strings.TrimRight(s[:len(s)-len("/chat/completions")], "/")
		return base, s
	}
	return s, s + "/chat/completions"
}

// Enabled reports whether the client is configured.
func (c *Client) Enabled() bool { return c != nil && c.endpoint != "" && c.model != "" }

// Model returns the configured model name.
func (c *Client) Model() string {
	if c == nil {
		return ""
	}
	return c.model
}

// BaseURL returns the normalised base URL (it never contains the key).
func (c *Client) BaseURL() string {
	if c == nil {
		return ""
	}
	return c.baseURL
}

// Thinking returns the configured thinking mode.
func (c *Client) Thinking() string {
	if c == nil {
		return ThinkingOff
	}
	return c.thinking
}

// Endpoint returns the chat completions URL (it never contains the key).
func (c *Client) Endpoint() string {
	if c == nil {
		return ""
	}
	return c.endpoint
}

// KeyHint describes the configured API key without revealing it.
func (c *Client) KeyHint() netdiag.KeyHint {
	if c == nil {
		return netdiag.Fingerprint("", netdiag.AnyKey)
	}
	format := netdiag.AnyKey
	if strings.Contains(strings.ToLower(c.host()), "deepseek") {
		format = netdiag.DeepSeekKey
	}
	return netdiag.Fingerprint(c.apiKey, format)
}

// Timeout returns the default call timeout.
func (c *Client) Timeout() time.Duration {
	if c == nil {
		return DefaultTimeout
	}
	return c.timeout
}

func (c *Client) host() string {
	if u, err := url.Parse(c.endpoint); err == nil && u.Host != "" {
		return u.Host
	}
	return c.endpoint
}

// Message is a chat message.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Options tune one call.
type Options struct {
	// JSON asks for response_format=json_object.
	JSON bool
	// MaxTokens limits the answer (0 = provider default).
	MaxTokens int
	// Temperature (nil = 0.4).
	Temperature *float64
}

// Delta is a piece of a streamed answer: Content is answer text, Reasoning
// is the model's thinking (DeepSeek reasoning_content), which callers only
// count as progress.
type Delta struct {
	Content   string
	Reasoning string
}

// body builds the request body: the base fields (model, messages,
// temperature, stream, max_tokens), then the optional ones a provider may
// not know: JSON mode (response_format), the thinking switch (thinking,
// reasoning_effort, enable_thinking) and TRIPHUB_AI_EXTRA_BODY. optional
// lists the keys that a retry without optional fields drops (see retryable).
func (c *Client) body(msgs []Message, o Options, stream bool) (body map[string]any, optional []string) {
	temp := 0.4
	if o.Temperature != nil {
		temp = *o.Temperature
	}
	body = map[string]any{"model": c.model, "messages": msgs, "temperature": temp, "stream": stream}
	if o.MaxTokens > 0 {
		body["max_tokens"] = o.MaxTokens
	}
	add := func(k string, v any) {
		body[k] = v
		optional = append(optional, k)
	}
	if o.JSON {
		add("response_format", map[string]string{"type": "json_object"})
	}
	for k, v := range thinkingFields(c.host(), c.thinking) {
		add(k, v)
	}
	for k, v := range c.extra {
		switch k {
		case "model", "messages", "stream":
			continue
		}
		if !slices.Contains(optional, k) {
			optional = append(optional, k)
		}
		body[k] = v
	}
	return body, optional
}

// thinkingFields returns the provider-specific fields that switch reasoning
// on or off: DeepSeek takes "thinking" (+ reasoning_effort), Alibaba
// DashScope (通义千问 / Qwen) takes "enable_thinking". Other providers get
// nothing (set TRIPHUB_AI_EXTRA_BODY for them).
func thinkingFields(host, mode string) map[string]any {
	host = strings.ToLower(host)
	switch {
	case strings.Contains(host, "deepseek"):
		switch mode {
		case ThinkingOff:
			return map[string]any{"thinking": map[string]string{"type": "disabled"}}
		case ThinkingOn:
			return map[string]any{"thinking": map[string]string{"type": "enabled"}}
		case ThinkingLow, ThinkingHigh, ThinkingMax:
			return map[string]any{"thinking": map[string]string{"type": "enabled"}, "reasoning_effort": mode}
		}
	case strings.Contains(host, "dashscope") || strings.Contains(host, "aliyuncs"):
		// Qwen reasoning requires streaming on DashScope; only switching it
		// off is sent, "on" keeps the model's own default.
		if mode == ThinkingOff {
			return map[string]any{"enable_thinking": false}
		}
	}
	return nil
}

type chatResponse struct {
	Choices []struct {
		Message struct {
			Content          *string `json:"content"`
			ReasoningContent string  `json:"reasoning_content"`
			Reasoning        string  `json:"reasoning"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Error json.RawMessage `json:"error"`
}

// Chat sends messages and returns the assistant text. When jsonMode is set it
// asks for response_format=json_object.
func (c *Client) Chat(ctx context.Context, msgs []Message, jsonMode bool) (string, error) {
	return c.Complete(ctx, msgs, Options{JSON: jsonMode})
}

// Complete sends messages and returns the answer (the message content; the
// reasoning is ignored). If the provider rejects an optional field (JSON
// mode, the thinking switch, TRIPHUB_AI_EXTRA_BODY) with 400 / 422, the
// request is retried once without the optional fields.
func (c *Client) Complete(ctx context.Context, msgs []Message, o Options) (string, error) {
	if !c.Enabled() {
		return "", ErrDisabled
	}
	ctx, cancel := c.withDeadline(ctx)
	defer cancel()
	start := time.Now()
	body, optional := c.body(msgs, o, false)
	return c.completeRetry(ctx, body, optional, start)
}

// completeRetry is complete, retried once without the optional fields when
// the provider rejects one of them.
func (c *Client) completeRetry(ctx context.Context, body map[string]any, optional []string, start time.Time) (string, error) {
	text, err := c.complete(ctx, body, start)
	if c.retryable(err, optional) {
		stripOptional(body, optional)
		text, err = c.complete(ctx, body, start)
	}
	return text, err
}

func stripOptional(body map[string]any, optional []string) {
	for _, k := range optional {
		delete(body, k)
	}
}

func (c *Client) withDeadline(ctx context.Context) (context.Context, context.CancelFunc) {
	if _, ok := ctx.Deadline(); ok {
		return context.WithCancel(ctx)
	}
	return context.WithTimeout(ctx, c.timeout)
}

func (c *Client) complete(ctx context.Context, body map[string]any, start time.Time) (string, error) {
	resp, tr, err := c.post(ctx, body, start)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return "", c.transportError(ctx, err, start, tr, nil)
	}
	return c.parseResponse(data)
}

func (c *Client) parseResponse(data []byte) (string, error) {
	var cr chatResponse
	if err := json.Unmarshal(data, &cr); err != nil {
		return "", &Error{Kind: KindBadResponse, Detail: "decode: " + err.Error(), err: err}
	}
	if msg := errorText(cr.Error); msg != "" {
		return "", c.classify(0, msg)
	}
	if len(cr.Choices) == 0 {
		return "", &Error{Kind: KindBadResponse, Detail: "empty choices"}
	}
	ch := cr.Choices[0]
	content := ""
	if ch.Message.Content != nil {
		content = *ch.Message.Content
	}
	reasoning := ch.Message.ReasoningContent + ch.Message.Reasoning
	return content, emptyError(content, reasoning != "", ch.FinishReason)
}

// emptyError reports an answer without content: only reasoning (the model
// ran out of tokens while thinking) or nothing at all.
func emptyError(content string, reasoned bool, finish string) error {
	if strings.TrimSpace(content) != "" {
		return nil
	}
	return &Error{Kind: KindEmpty, Detail: fmt.Sprintf("empty content (reasoning=%v, finish_reason=%q)", reasoned, finish), reasoned: reasoned}
}

// post sends the request; a non-2xx answer becomes an *Error. The trace
// tells later read errors apart (slow model or broken connection).
func (c *Client) post(ctx context.Context, body map[string]any, start time.Time) (*http.Response, *netdiag.Trace, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return nil, nil, err
	}
	tr := netdiag.NewTrace()
	req, err := http.NewRequestWithContext(tr.Context(ctx), http.MethodPost, c.endpoint, bytes.NewReader(b))
	if err != nil {
		return nil, nil, &Error{Kind: KindNetwork, Detail: err.Error(), host: c.host(), err: err}
	}
	req.Header.Set("Content-Type", "application/json")
	if body["stream"] == true {
		req.Header.Set("Accept", "text/event-stream, application/json")
	} else {
		req.Header.Set("Accept", "application/json")
	}
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, tr, c.transportError(ctx, err, start, tr, netdiag.ProxyOf(c.http, req))
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		resp.Body.Close()
		field := extractErrorField(data)
		msg := errorText(field)
		if msg == "" {
			msg = netdiag.BodySnippet(data, 500)
		}
		e := c.classify(resp.StatusCode, msg)
		if resp.StatusCode == http.StatusForbidden && field == nil {
			// Not the provider's JSON error: a proxy, firewall or gateway
			// page, not a verdict on the key.
			e.Kind, e.blocked = KindRequest, true
		}
		return nil, tr, e
	}
	return resp, tr, nil
}

// transportError classifies a failure to send or read by how far the
// request got (see netdiag.Trace): no connection or request sent is a
// network failure (DNS, proxy, connect, TLS); a deadline after the request
// was sent is a timeout; a broken connection is a network failure too. The
// caller going away is a cancellation. proxy is the proxy used (nil: direct
// or unknown).
func (c *Client) transportError(ctx context.Context, err error, start time.Time, tr *netdiag.Trace, proxy *url.URL) error {
	detail := netdiag.ErrorText(err, c.apiKey)
	waited := time.Since(start)
	if errors.Is(ctx.Err(), context.Canceled) {
		return &Error{Kind: KindCanceled, Detail: detail, err: context.Canceled}
	}
	in := tr.Info()
	timeout := netdiag.IsTimeout(err) || errors.Is(ctx.Err(), context.DeadlineExceeded)
	if in.GotConn && in.WroteRequest && timeout {
		return &Error{Kind: KindTimeout, Detail: detail, host: c.host(), waited: waited, noResponse: !in.FirstByte,
			err: context.DeadlineExceeded}
	}
	return &Error{Kind: KindNetwork, Detail: detail, Net: netdiag.Classify(err, tr, proxy), host: c.host(), waited: waited, err: err}
}

func extractErrorField(data []byte) json.RawMessage {
	var v struct {
		Error   json.RawMessage `json:"error"`
		Message string          `json:"message"`
		Msg     string          `json:"msg"`
	}
	if json.Unmarshal(data, &v) != nil {
		return nil
	}
	if len(v.Error) > 0 && string(v.Error) != "null" {
		return v.Error
	}
	for _, s := range []string{v.Message, v.Msg} {
		if s != "" {
			b, _ := json.Marshal(s)
			return b
		}
	}
	return nil
}

// errorText renders an "error" field: {"message": …, "code": …} or a string.
func errorText(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var obj struct {
		Message string `json:"message"`
		Code    any    `json:"code"`
		Type    string `json:"type"`
		Param   any    `json:"param"`
	}
	if json.Unmarshal(raw, &obj) != nil {
		return string(raw)
	}
	parts := []string{}
	for _, p := range []any{obj.Message, obj.Code, obj.Type, obj.Param} {
		if p == nil {
			continue
		}
		if t := strings.TrimSpace(fmt.Sprint(p)); t != "" && t != "<nil>" {
			parts = append(parts, t)
		}
	}
	return strings.Join(parts, " | ")
}

// modelMissingRe matches "model not found" messages: DeepSeek "Model Not
// Exist", OpenAI "The model `x` does not exist", Ollama "model 'x' not
// found", Kimi "Not found the model x", 智谱 "模型不存在".
var modelMissingRe = regexp.MustCompile(`(?i)(model_not_found|模型不存在|unknown model|no such model|not found the model|model[^.|]{0,60}?(does not exist|not[ _]?exist|not[ _]found))`)

// classify maps an HTTP status and the provider's message to an *Error.
func (c *Client) classify(status int, msg string) *Error {
	msg = netdiag.Redact(msg, c.apiKey)
	if len(msg) > 500 {
		msg = strings.ToValidUTF8(msg[:500], "")
	}
	e := &Error{Status: status, Detail: msg, model: c.model, host: c.host()}
	lower := strings.ToLower(msg)
	switch {
	case status == http.StatusUnauthorized || status == http.StatusForbidden ||
		strings.Contains(lower, "authentication") || strings.Contains(lower, "invalid api key") || strings.Contains(lower, "incorrect api key"):
		e.Kind = KindAuth
	case status == http.StatusPaymentRequired || strings.Contains(lower, "insufficient balance") || strings.Contains(lower, "insufficient_quota") ||
		strings.Contains(lower, "余额不足") || strings.Contains(lower, "arrearage"):
		e.Kind = KindBalance
	case (status == 0 || status == http.StatusBadRequest || status == http.StatusNotFound || status == http.StatusUnprocessableEntity) &&
		modelMissingRe.MatchString(msg):
		e.Kind = KindModel
	case status == http.StatusTooManyRequests:
		e.Kind = KindRateLimit
	case status >= 500:
		e.Kind = KindServer
	case status >= 400:
		e.Kind = KindRequest
	default:
		e.Kind = KindProvider
	}
	return e
}

var unsupportedRe = regexp.MustCompile(`(?i)(unknown|unsupported|not supported|unrecognized|unrecognised|not permitted|not allowed|extra (fields|inputs)|additional propert|invalid (param|field|argument|request)|unexpected (field|keyword|param)|不支持|未知参数|无效参数)`)

// retryable reports whether a request was rejected because of one of its
// optional fields (a 400 / 422 that names the field or an unknown
// parameter), so that it is worth one more try without them.
func (c *Client) retryable(err error, optional []string) bool {
	var e *Error
	if len(optional) == 0 || !errors.As(err, &e) || e.Kind != KindRequest ||
		(e.Status != http.StatusBadRequest && e.Status != http.StatusUnprocessableEntity) {
		return false
	}
	lower := strings.ToLower(e.Detail)
	for _, k := range optional {
		if strings.Contains(lower, strings.ToLower(k)) {
			return true
		}
	}
	return unsupportedRe.MatchString(e.Detail)
}

// ChatStream is Complete with stream=true: onDelta (may be nil) receives the
// answer and the reasoning as they arrive. A provider that answers a
// streaming request with plain JSON is handled too; one that rejects
// streaming (an error before any output) is asked again without it.
func (c *Client) ChatStream(ctx context.Context, msgs []Message, o Options, onDelta func(Delta)) (string, error) {
	if !c.Enabled() {
		return "", ErrDisabled
	}
	ctx, cancel := c.withDeadline(ctx)
	defer cancel()
	start := time.Now()
	body, optional := c.body(msgs, o, true)
	text, got, err := c.stream(ctx, body, start, onDelta)
	if !got && c.retryable(err, optional) && !namesStream(err) {
		stripOptional(body, optional)
		optional = nil
		text, got, err = c.stream(ctx, body, start, onDelta)
	}
	if err != nil && !got && streamUnsupported(err) {
		body["stream"] = false
		text, err = c.completeRetry(ctx, body, optional, start)
	}
	return text, err
}

// namesStream reports a rejection that is about streaming itself.
func namesStream(err error) bool {
	var e *Error
	return errors.As(err, &e) && strings.Contains(strings.ToLower(e.Detail), "stream")
}

// streamUnsupported reports errors after which a non-streaming request may
// still work: the request or the stream itself was not understood.
func streamUnsupported(err error) bool {
	var e *Error
	if !errors.As(err, &e) {
		return false
	}
	switch e.Kind {
	case KindRequest, KindBadResponse:
		return true
	case KindServer:
		return e.Status == http.StatusNotImplemented
	}
	return false
}

// stream runs one streaming request. got reports whether any output
// (answer or reasoning) arrived.
func (c *Client) stream(ctx context.Context, body map[string]any, start time.Time, onDelta func(Delta)) (text string, got bool, err error) {
	resp, tr, err := c.post(ctx, body, start)
	if err != nil {
		return "", false, err
	}
	defer resp.Body.Close()
	if ct := strings.ToLower(resp.Header.Get("Content-Type")); !strings.Contains(ct, "event-stream") && strings.Contains(ct, "json") {
		// Streaming ignored: a normal JSON answer.
		data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		if err != nil {
			return "", false, c.transportError(ctx, err, start, tr, nil)
		}
		text, err := c.parseResponse(data)
		if err == nil && onDelta != nil {
			onDelta(Delta{Content: text})
		}
		return text, err == nil, err
	}
	var content strings.Builder
	reasoned := false
	finish := ""
	done := false
	r := bufio.NewReaderSize(resp.Body, 64<<10)
	for !done {
		line, rerr := r.ReadString('\n')
		line = strings.TrimRight(line, "\r\n")
		if data, ok := strings.CutPrefix(line, "data:"); ok {
			data = strings.TrimSpace(data)
			if data == "[DONE]" {
				done = true
				break
			}
			if data != "" {
				d, fr, perr := c.parseChunk(data)
				if perr != nil {
					return content.String(), got, perr
				}
				if fr != "" {
					finish = fr
				}
				if d.Content != "" || d.Reasoning != "" {
					got = true
					content.WriteString(d.Content)
					if d.Reasoning != "" {
						reasoned = true
					}
					if onDelta != nil {
						onDelta(d)
					}
				}
			}
		}
		if rerr != nil {
			if rerr == io.EOF {
				break // some servers close without [DONE]
			}
			return content.String(), got, c.transportError(ctx, rerr, start, tr, nil)
		}
		if content.Len() > 8<<20 {
			return "", got, &Error{Kind: KindBadResponse, Detail: "answer too long"}
		}
	}
	text = content.String()
	return text, got, emptyError(text, reasoned, finish)
}

type streamChunk struct {
	Choices []struct {
		Delta struct {
			Content          *string `json:"content"`
			ReasoningContent *string `json:"reasoning_content"`
			Reasoning        *string `json:"reasoning"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
	Error json.RawMessage `json:"error"`
}

func (c *Client) parseChunk(data string) (Delta, string, error) {
	var ch streamChunk
	if err := json.Unmarshal([]byte(data), &ch); err != nil {
		return Delta{}, "", &Error{Kind: KindBadResponse, Detail: "stream decode: " + err.Error(), err: err}
	}
	if msg := errorText(ch.Error); msg != "" {
		return Delta{}, "", c.classify(0, msg)
	}
	var d Delta
	finish := ""
	for _, choice := range ch.Choices[:min(len(ch.Choices), 1)] {
		if p := choice.Delta.Content; p != nil {
			d.Content = *p
		}
		if p := choice.Delta.ReasoningContent; p != nil {
			d.Reasoning += *p
		}
		if p := choice.Delta.Reasoning; p != nil {
			d.Reasoning += *p
		}
		if p := choice.FinishReason; p != nil {
			finish = *p
		}
	}
	return d, finish, nil
}

// ChatJSON asks for a JSON answer and decodes it into out, tolerating models
// that wrap JSON in prose, markdown fences or <think> blocks.
func (c *Client) ChatJSON(ctx context.Context, system, user string, out any) error {
	text, err := c.Chat(ctx, []Message{{Role: "system", Content: system}, {Role: "user", Content: user}}, true)
	if err != nil {
		return err
	}
	return DecodeJSON(text, out)
}

// DecodeJSON extracts the JSON object of a model answer (see ExtractJSON)
// and decodes it into out.
func DecodeJSON(text string, out any) error {
	js, err := ExtractJSON(text)
	if err != nil {
		return err
	}
	if err := json.Unmarshal([]byte(js), out); err != nil {
		return fmt.Errorf("ai json: %w", err)
	}
	return nil
}

// Ping sends a minimal request ("只回复 ok") and returns the answer; used
// by the admin diagnostics to check the configuration.
func (c *Client) Ping(ctx context.Context) (string, error) {
	tokens := 16
	if c.Thinking() != ThinkingOff {
		tokens = 2048 // the reasoning counts against max_tokens
	}
	zero := 0.0
	return c.Complete(ctx, []Message{{Role: "user", Content: "只回复 ok"}}, Options{MaxTokens: tokens, Temperature: &zero})
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
