package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
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
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatal(err)
		}
		// Simulate a server that rejects response_format (e.g. some local runtimes).
		if req.ResponseFormat != nil {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"message":"response_format not supported"}}`))
			return
		}
		if req.Model != "test-model" || len(req.Messages) != 2 || req.Messages[0].Role != "system" {
			t.Errorf("unexpected request %+v", req)
		}
		reply := "```json\n{\"title\":\"杭州一日\",\"items\":[{\"day\":1,\"name\":\"西湖\"}]}\n```"
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": reply}}},
		})
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
	if !strings.Contains((&HTTPError{Status: 500, Body: "x"}).Error(), "500") {
		t.Fatal("HTTPError message")
	}
}
