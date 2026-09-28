package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"triphub/internal/netdiag"
)

func TestExtractJSON(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{`{"a":1}`, `{"a":1}`},
		{"```json\n{\"a\": {\"b\": \"}\"}}\n```", `{"a": {"b": "}"}}`},
		{"好的，下面是结果：\n{\"title\":\"杭州\",\"items\":[]}\n希望对你有帮助", `{"title":"杭州","items":[]}`},
		{"<think>先想想 {不是JSON}</think>\n{\"ok\":true}", `{"ok":true}`},
		{`前缀 {broken {"x":"a\"b"} 后缀`, `{"x":"a\"b"}`},
		{"```\n{\"n\": [1,2,3]}\n```", `{"n": [1,2,3]}`},
	}
	for _, c := range cases {
		got, err := ExtractJSON(c.in)
		if err != nil || got != c.want {
			t.Errorf("ExtractJSON(%q) = %q, %v; want %q", c.in, got, err, c.want)
		}
	}
	for _, bad := range []string{"", "no json here", "{unterminated", "[1,2]"} {
		if _, err := ExtractJSON(bad); err == nil {
			t.Errorf("expected error for %q", bad)
		}
	}
}

func TestNormalizeBaseURL(t *testing.T) {
	cases := map[string][2]string{
		"https://api.deepseek.com":                  {"https://api.deepseek.com", "https://api.deepseek.com/chat/completions"},
		" https://api.deepseek.com/ ":               {"https://api.deepseek.com", "https://api.deepseek.com/chat/completions"},
		"https://api.deepseek.com/v1":               {"https://api.deepseek.com/v1", "https://api.deepseek.com/v1/chat/completions"},
		"https://api.deepseek.com/v1//":             {"https://api.deepseek.com/v1", "https://api.deepseek.com/v1/chat/completions"},
		"https://api.deepseek.com/chat/completions": {"https://api.deepseek.com", "https://api.deepseek.com/chat/completions"},
		"https://x.test/v1/chat/completions/":       {"https://x.test/v1", "https://x.test/v1/chat/completions"},
		"api.moonshot.cn/v1":                        {"https://api.moonshot.cn/v1", "https://api.moonshot.cn/v1/chat/completions"},
		"http://host.docker.internal:11434/v1":      {"http://host.docker.internal:11434/v1", "http://host.docker.internal:11434/v1/chat/completions"},
		"":                                          {"", ""},
		"https://dashscope.aliyuncs.com/compatible-mode/v1": {"https://dashscope.aliyuncs.com/compatible-mode/v1",
			"https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"},
	}
	for in, want := range cases {
		base, ep := NormalizeBaseURL(in)
		if base != want[0] || ep != want[1] {
			t.Errorf("NormalizeBaseURL(%q) = %q, %q; want %q, %q", in, base, ep, want[0], want[1])
		}
	}
}

// The thinking switch depends on the provider (host) and the mode.
func TestThinkingParamPerHost(t *testing.T) {
	msgs := []Message{{Role: "user", Content: "hi"}}
	body := func(base, mode string, extra map[string]any) map[string]any {
		b, _ := NewClient(Config{BaseURL: base, Model: "m", Thinking: mode, ExtraBody: extra}).body(msgs, Options{JSON: true}, false)
		raw, _ := json.Marshal(b)
		var out map[string]any
		_ = json.Unmarshal(raw, &out)
		return out
	}
	js := func(v any) string { b, _ := json.Marshal(v); return string(b) }

	ds := body("https://api.deepseek.com", "", nil)
	if js(ds["thinking"]) != `{"type":"disabled"}` || ds["reasoning_effort"] != nil || js(ds["response_format"]) != `{"type":"json_object"}` {
		t.Fatalf("deepseek, thinking off by default: %v", ds)
	}
	if b := body("https://api.deepseek.com/v1", "on", nil); js(b["thinking"]) != `{"type":"enabled"}` || b["reasoning_effort"] != nil {
		t.Fatalf("deepseek on: %v", b)
	}
	for _, mode := range []string{"low", "high", "max"} {
		if b := body("https://api.deepseek.com", mode, nil); js(b["thinking"]) != `{"type":"enabled"}` || b["reasoning_effort"] != mode {
			t.Fatalf("deepseek %s: %v", mode, b)
		}
	}
	for _, base := range []string{"https://dashscope.aliyuncs.com/compatible-mode/v1", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"} {
		if b := body(base, "off", nil); b["enable_thinking"] != false || b["thinking"] != nil {
			t.Fatalf("dashscope off: %v", b)
		}
		if b := body(base, "on", nil); b["enable_thinking"] != nil {
			t.Fatalf("dashscope on keeps the model default: %v", b)
		}
	}
	for _, base := range []string{"https://api.moonshot.cn/v1", "http://host.docker.internal:11434/v1"} {
		b := body(base, "off", nil)
		if b["thinking"] != nil || b["enable_thinking"] != nil || b["reasoning_effort"] != nil {
			t.Fatalf("%s: no thinking fields for other providers: %v", base, b)
		}
	}
	// TRIPHUB_AI_EXTRA_BODY overrides, but never model / messages / stream.
	b := body("https://api.deepseek.com", "off", map[string]any{"thinking": map[string]any{"type": "enabled"}, "top_p": 0.9,
		"model": "evil", "stream": true})
	if js(b["thinking"]) != `{"type":"enabled"}` || b["top_p"] != 0.9 || b["model"] != "m" || b["stream"] != false {
		t.Fatalf("extra body: %v", b)
	}
	if b := body("https://api.openai.com/v1", "off", map[string]any{"enable_thinking": false}); b["enable_thinking"] != false {
		t.Fatalf("extra body for other providers: %v", b)
	}
}

func chatJSON(content string) map[string]any {
	return map[string]any{"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": content}}}}
}

func TestChatJSONWithFakeServer(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer sk-test" {
			t.Errorf("auth header %q", got)
		}
		var req map[string]any
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatal(err)
		}
		// Simulate a server that rejects response_format (e.g. some local runtimes).
		if req["response_format"] != nil {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"message":"response_format not supported"}}`))
			return
		}
		if req["model"] != "test-model" || len(req["messages"].([]any)) != 2 || req["stream"] != false {
			t.Errorf("unexpected request %+v", req)
		}
		reply := "```json\n{\"title\":\"杭州一日\",\"items\":[{\"day\":1,\"name\":\"西湖\"}]}\n```"
		_ = json.NewEncoder(w).Encode(chatJSON(reply))
	}))
	defer srv.Close()

	c := New(srv.URL+"/v1/", "sk-test", "test-model", 5*time.Second)
	if !c.Enabled() {
		t.Fatal("client should be enabled")
	}
	var out struct {
		Title string `json:"title"`
		Items []struct {
			Day  int    `json:"day"`
			Name string `json:"name"`
		} `json:"items"`
	}
	if err := c.ChatJSON(context.Background(), "你是助手", "规划杭州", &out); err != nil {
		t.Fatal(err)
	}
	if out.Title != "杭州一日" || len(out.Items) != 1 || out.Items[0].Name != "西湖" {
		t.Fatalf("unexpected result %+v", out)
	}
	if calls != 2 {
		t.Fatalf("expected a retry without response_format, got %d calls", calls)
	}

	if New("", "", "", 0).Enabled() {
		t.Fatal("empty client should be disabled")
	}
	if err := New("", "", "", 0).ChatJSON(context.Background(), "", "", &out); err != ErrDisabled {
		t.Fatalf("expected ErrDisabled, got %v", err)
	}
	if UserMessage(ErrDisabled) != "未配置 AI 服务" || UserMessage(ErrNoJSON) != "AI 返回的内容无法解析，请重试" {
		t.Fatal("UserMessage")
	}
}

// A provider that rejects an optional parameter (the thinking switch, JSON
// mode, TRIPHUB_AI_EXTRA_BODY) is asked once more without the optional
// fields; other 400s are not retried.
func TestRetryWithoutUnknownParam(t *testing.T) {
	var mu sync.Mutex
	var bodies []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		mu.Lock()
		bodies = append(bodies, req)
		mu.Unlock()
		prompt := req["messages"].([]any)[0].(map[string]any)["content"].(string)
		switch {
		case prompt == "too long":
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"message":"This model's maximum context length is 8192 tokens","type":"invalid_request_error"}}`))
		case req["thinking"] != nil:
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"object":"error","message":"[{'type': 'extra_forbidden', 'loc': ('body', 'thinking'), 'msg': 'Extra inputs are not permitted'}]","code":400}`))
		default:
			_ = json.NewEncoder(w).Encode(chatJSON(`{"ok":true}`))
		}
	}))
	defer srv.Close()
	c := NewClient(Config{BaseURL: srv.URL, Model: "m", ExtraBody: map[string]any{"thinking": map[string]any{"type": "disabled"}, "top_k": 20}})
	text, err := c.Complete(context.Background(), []Message{{Role: "user", Content: "hi"}}, Options{JSON: true})
	if err != nil || text != `{"ok":true}` {
		t.Fatalf("retry: %q %v", text, err)
	}
	if len(bodies) != 2 {
		t.Fatalf("%d requests, want 2", len(bodies))
	}
	for _, k := range []string{"thinking", "response_format", "top_k"} {
		if bodies[0][k] == nil || bodies[1][k] != nil {
			t.Fatalf("%s: first %v, retry %v", k, bodies[0][k], bodies[1][k])
		}
	}
	if bodies[1]["model"] != "m" || bodies[1]["messages"] == nil {
		t.Fatalf("retry lost the base fields: %v", bodies[1])
	}
	bodies = nil
	_, err = c.Complete(context.Background(), []Message{{Role: "user", Content: "too long"}}, Options{JSON: true})
	var e *Error
	if !errors.As(err, &e) || e.Kind != KindRequest || e.Status != 400 || len(bodies) != 1 {
		t.Fatalf("an unrelated 400 must not be retried: %v (%d requests)", err, len(bodies))
	}
	if !strings.Contains(UserMessage(err), "HTTP 400") {
		t.Fatalf("message: %s", UserMessage(err))
	}
}

func TestErrorMapping(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		switch req["model"] {
		case "auth":
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"message":"Authentication Fails, Your api key: ****abcd is invalid","type":"authentication_error"}}`))
		case "forbidden":
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"error":{"message":"access denied"}}`))
		case "blocked":
			// A proxy / WAF page, not the provider's error.
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`<html><head><title>Access Denied</title></head><body>blocked by WAF</body></html>`))
		case "echo":
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"message":"bad key sk-secret"}}`))
		case "headers-then-slow":
			// The answer starts, then the model takes too long.
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("\n"))
			w.(http.Flusher).Flush()
			select {
			case <-time.After(3 * time.Second):
			case <-r.Context().Done():
			}
		case "poor":
			w.WriteHeader(http.StatusPaymentRequired)
			_, _ = w.Write([]byte(`{"error":{"message":"Insufficient Balance","type":"unknown_error"}}`))
		case "nosuch":
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"message":"Model Not Exist","type":"invalid_request_error"}}`))
		case "nosuch-openai":
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":{"message":"The model 'nosuch-openai' does not exist or you do not have access to it.","code":"model_not_found"}}`))
		case "busy":
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`Server Overloaded`))
		case "slow":
			select {
			case <-time.After(3 * time.Second):
			case <-r.Context().Done():
			}
		case "thinker":
			// Reasoning only, no answer (ran out of tokens while thinking).
			_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"","reasoning_content":"让我想想……"},"finish_reason":"length"}]}`))
		case "silent":
			_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":null}}]}`))
		case "inline":
			_, _ = w.Write([]byte(`{"error":{"message":"quota exceeded"}}`))
		default:
			_ = json.NewEncoder(w).Encode(chatJSON("ok"))
		}
	}))
	defer srv.Close()
	call := func(model string, timeout time.Duration) error {
		c := NewClient(Config{BaseURL: srv.URL + "/v1", Model: model, APIKey: "sk-secret"})
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		_, err := c.Complete(ctx, []Message{{Role: "user", Content: "hi"}}, Options{})
		return err
	}
	for model, want := range map[string]string{
		"auth":          "AI Key 无效或没有权限（HTTP 401：Authentication Fails, Your api key: ****abcd is invalid",
		"forbidden":     "AI Key 无效或没有权限（HTTP 403：access denied）",
		"blocked":       "AI 服务拒绝访问（HTTP 403），且返回的不是服务商的错误信息：可能被代理、防火墙或网关拦截（HTML 页面「Access Denied」（被 WAF / 防火墙拦截））",
		"poor":          "AI 账户余额或额度不足（HTTP 402），请到模型服务商的控制台充值",
		"nosuch":        "模型不存在：nosuch（HTTP 400：Model Not Exist",
		"nosuch-openai": "模型不存在：nosuch-openai",
		"busy":          "AI 服务繁忙（HTTP 503，服务器过载），请稍后再试",
		"echo":          "AI 服务拒绝了请求（HTTP 400）：bad key ***",
		"thinker":       "AI 只返回了思考过程",
		"silent":        "AI 返回了空内容",
		"inline":        "AI 服务出错：quota exceeded",
	} {
		err := call(model, 5*time.Second)
		if msg := UserMessage(err); !strings.HasPrefix(msg, want) {
			t.Errorf("%s: %q (%v), want %q", model, msg, err, want)
		}
	}
	if err := call("ok", 5*time.Second); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	err := call("slow", 1100*time.Millisecond)
	var e *Error
	if !errors.As(err, &e) || e.Kind != KindTimeout || !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > 2*time.Second {
		t.Fatalf("timeout: %v", err)
	}
	// Sent, but no answer at all: not blamed on the model alone.
	if msg := UserMessage(err); !strings.HasPrefix(msg, "请求已发出，但 AI 服务（127.0.0.1:") || !strings.Contains(msg, "在 1 秒内没有任何响应：多为网络、代理或防火墙问题") ||
		strings.Contains(msg, "换用更快的模型") || e.Layer() != "timeout" {
		t.Fatalf("timeout message: %s", msg)
	}
	// The answer started, then the model was too slow.
	err = call("headers-then-slow", 1100*time.Millisecond)
	if !errors.As(err, &e) || e.Kind != KindTimeout || UserMessage(err) != "AI 响应超时（等待了 1 秒），可在设置中换用更快的模型或关闭深度思考" {
		t.Fatalf("slow model: %v %q", err, UserMessage(err))
	}
	// Not a network failure: the diagnostics must not send the operator
	// after the network.
	if e.Layer() != "slow" || Details(err).Layer != "slow" || netdiag.IsNetwork(e.Layer()) {
		t.Fatalf("slow model layer: %q", e.Layer())
	}
	// A 403 page that is not the provider's error is flagged as blocked.
	if err := call("blocked", 5*time.Second); !Details(err).Blocked || Details(err).Layer != "http" {
		t.Fatalf("blocked details: %+v", Details(err))
	}
	if err := call("forbidden", 5*time.Second); Details(err).Blocked {
		t.Fatalf("the provider's own 403 is not blocked: %+v", Details(err))
	}
	// Nothing listens on port 1: a network failure, never a bad key or a slow model.
	c := NewClient(Config{BaseURL: "http://127.0.0.1:1/v1", Model: "m", APIKey: "sk-secret"})
	_, err = c.Complete(context.Background(), []Message{{Role: "user", Content: "hi"}}, Options{})
	if msg := UserMessage(err); msg != "无法连接 AI 服务（127.0.0.1:1）：TCP 连接 127.0.0.1:1 失败：连接被拒绝（connection refused）" ||
		strings.Contains(err.Error(), "sk-secret") {
		t.Fatalf("network: %q (%v)", msg, err)
	}
	if d := Details(err); d.Layer != "connect" || !strings.Contains(d.Detail, "connection refused") {
		t.Fatalf("network details: %+v", d)
	}
	// A connection that cannot be made in time is a network failure too.
	ln, lerr := net.Listen("tcp", "127.0.0.1:0")
	if lerr != nil {
		t.Fatal(lerr)
	}
	defer ln.Close()
	go func() { // accepts, never speaks TLS
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			defer conn.Close()
		}
	}()
	c = NewClient(Config{BaseURL: "https://" + ln.Addr().String(), Model: "m"})
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	_, err = c.Complete(ctx, []Message{{Role: "user", Content: "hi"}}, Options{})
	if !errors.As(err, &e) || e.Kind != KindNetwork || e.Layer() != "tls" || strings.Contains(UserMessage(err), "换用更快的模型") ||
		!strings.Contains(UserMessage(err), "TLS 握手超时") {
		t.Fatalf("tls stall: %v %q", err, UserMessage(err))
	}
}

func TestDeepSeekBalanceMessage(t *testing.T) {
	e := &Error{Kind: KindBalance, Status: 402, host: "api.deepseek.com"}
	if e.Message() != "AI 账户余额不足，请在 DeepSeek 平台（platform.deepseek.com）充值（HTTP 402）" || e.Layer() != "http" || e.KindName() != "balance" {
		t.Fatalf("balance: %q %s", e.Message(), e.Layer())
	}
	if (&Error{Kind: KindProvider, Detail: "x"}).Layer() != "api" {
		t.Fatal("an error in a 2xx answer is an api error")
	}
}

func sseServer(t *testing.T, handle func(w http.ResponseWriter, req map[string]any)) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
		}
		handle(w, req)
	}))
}

func writeSSE(w http.ResponseWriter, chunks ...string) {
	w.Header().Set("Content-Type", "text/event-stream")
	for _, ch := range chunks {
		_, _ = io.WriteString(w, ch)
		w.(http.Flusher).Flush()
	}
}

func delta(field, text string) string {
	b, _ := json.Marshal(map[string]any{"id": "x", "object": "chat.completion.chunk",
		"choices": []any{map[string]any{"index": 0, "delta": map[string]any{field: text}, "finish_reason": nil}}})
	return "data: " + string(b) + "\n\n"
}

func TestChatStream(t *testing.T) {
	srv := sseServer(t, func(w http.ResponseWriter, req map[string]any) {
		if req["stream"] != true {
			t.Errorf("stream flag: %v", req["stream"])
		}
		writeSSE(w,
			": keep-alive\n\n",
			delta("reasoning_content", "先想想"),
			delta("reasoning_content", "路线……"),
			delta("content", `{"title":`),
			"data:"+strings.TrimPrefix(delta("content", `"杭州"}`), "data: "), // no space after "data:"
			`data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":9}}`+"\n\n",
			"data: [DONE]\n\n",
		)
	})
	defer srv.Close()
	c := New(srv.URL, "", "m", 5*time.Second)
	var got []Delta
	text, err := c.ChatStream(context.Background(), []Message{{Role: "user", Content: "hi"}}, Options{JSON: true}, func(d Delta) { got = append(got, d) })
	if err != nil || text != `{"title":"杭州"}` {
		t.Fatalf("stream: %q %v", text, err)
	}
	var reasoning, content string
	for _, d := range got {
		reasoning += d.Reasoning
		content += d.Content
	}
	if reasoning != "先想想路线……" || content != text || len(got) != 4 {
		t.Fatalf("deltas: %+v", got)
	}
}

func TestChatStreamReasoningOnly(t *testing.T) {
	srv := sseServer(t, func(w http.ResponseWriter, req map[string]any) {
		writeSSE(w, delta("reasoning_content", "想了很久"), "data: [DONE]\n\n")
	})
	defer srv.Close()
	_, err := New(srv.URL, "", "m", 5*time.Second).ChatStream(context.Background(), []Message{{Role: "user", Content: "hi"}}, Options{}, nil)
	var e *Error
	if !errors.As(err, &e) || e.Kind != KindEmpty || !strings.Contains(e.Message(), "只返回了思考过程") {
		t.Fatalf("reasoning only: %v", err)
	}
}

// Providers without streaming: one rejects stream=true, one ignores it.
func TestChatStreamFallback(t *testing.T) {
	var mu sync.Mutex
	var streams []any
	srv := sseServer(t, func(w http.ResponseWriter, req map[string]any) {
		mu.Lock()
		streams = append(streams, req["stream"])
		mu.Unlock()
		model := req["model"]
		switch {
		case model == "nostream" && req["stream"] == true:
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"message":"stream mode is not supported"}}`))
		default: // plain JSON, also for stream=true ("ignores")
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(chatJSON(fmt.Sprintf(`{"model":"%v"}`, model)))
		}
	})
	defer srv.Close()
	for _, model := range []string{"nostream", "ignores"} {
		streams = nil
		var deltas int
		text, err := New(srv.URL, "", model, 5*time.Second).ChatStream(context.Background(),
			[]Message{{Role: "user", Content: "hi"}}, Options{}, func(Delta) { deltas++ })
		if err != nil || text != fmt.Sprintf(`{"model":"%s"}`, model) {
			t.Fatalf("%s: %q %v", model, text, err)
		}
		want := []any{true}
		if model == "nostream" {
			want = []any{true, false}
		}
		if fmt.Sprint(streams) != fmt.Sprint(want) {
			t.Fatalf("%s: stream flags %v, want %v", model, streams, want)
		}
		if model == "ignores" && deltas != 1 {
			t.Fatalf("the JSON answer should be reported as one delta: %d", deltas)
		}
	}
	// A broken key is not a streaming problem: no second request.
	auth := sseServer(t, func(w http.ResponseWriter, req map[string]any) {
		mu.Lock()
		streams = append(streams, req["stream"])
		mu.Unlock()
		w.WriteHeader(http.StatusUnauthorized)
	})
	defer auth.Close()
	streams = nil
	_, err := New(auth.URL, "k", "m", 5*time.Second).ChatStream(context.Background(), []Message{{Role: "user", Content: "hi"}}, Options{}, nil)
	if !strings.HasPrefix(UserMessage(err), "AI Key 无效或没有权限（HTTP 401）") || len(streams) != 1 {
		t.Fatalf("auth error while streaming: %v (%d requests)", err, len(streams))
	}
}

func TestPing(t *testing.T) {
	srv := sseServer(t, func(w http.ResponseWriter, req map[string]any) {
		if req["max_tokens"] != float64(16) || req["temperature"] != float64(0) {
			t.Errorf("ping request: %v", req)
		}
		_ = json.NewEncoder(w).Encode(chatJSON("ok"))
	})
	defer srv.Close()
	c := NewClient(Config{BaseURL: srv.URL, Model: "m"})
	if text, err := c.Ping(context.Background()); err != nil || text != "ok" {
		t.Fatalf("ping: %q %v", text, err)
	}
	if c.Model() != "m" || c.BaseURL() != srv.URL || c.Thinking() != ThinkingOff {
		t.Fatalf("accessors: %s %s %s", c.Model(), c.BaseURL(), c.Thinking())
	}
}
