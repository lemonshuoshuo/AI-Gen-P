package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func clearServiceEnv(t *testing.T) {
	for _, k := range []string{"TRIPHUB_AMAP_KEY", "TRIPHUB_AI_BASE_URL", "TRIPHUB_AI_API_KEY", "TRIPHUB_AI_MODEL", "TRIPHUB_TIANDITU_KEY",
		"TRIPHUB_AI_THINKING", "TRIPHUB_AI_EXTRA_BODY"} {
		t.Setenv(k, "")
	}
	// A database that does not exist: -diagnose must not need one.
	t.Setenv("TRIPHUB_DB_DSN", "postgres://nobody:x@127.0.0.1:1/none?sslmode=disable")
}

func TestDiagnoseNothingConfigured(t *testing.T) {
	clearServiceEnv(t)
	var out bytes.Buffer
	if code := runDiagnose(&out); code != 0 {
		t.Fatalf("exit %d:\n%s", code, out.String())
	}
	if s := out.String(); !strings.Contains(s, "[高德地图] 未配置") || !strings.Contains(s, "没有配置任何外部服务") {
		t.Fatalf("output:\n%s", s)
	}
}

func TestDiagnoseAI(t *testing.T) {
	clearServiceEnv(t)
	const key = "sk-0123456789abcdef0123456789abcdef"
	status := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+key {
			t.Errorf("authorization: %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if status != http.StatusOK {
			_, _ = w.Write([]byte(`{"error":{"message":"Authentication Fails, Your api key: ****cdef is invalid"}}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "ok"}}}})
	}))
	defer srv.Close()
	t.Setenv("TRIPHUB_AI_BASE_URL", srv.URL)
	t.Setenv("TRIPHUB_AI_MODEL", "m")
	t.Setenv("TRIPHUB_AI_API_KEY", `"`+key+`"  # 注释`)
	var out bytes.Buffer
	if code := runDiagnose(&out); code != 0 {
		t.Fatalf("exit %d:\n%s", code, out.String())
	}
	s := out.String()
	for _, want := range []string{"TRIPHUB_AI_API_KEY 的值里有多余的内容（首尾引号、行尾注释）", "长度 35 · sk-0…cdef", "DNS", "TCP     通过",
		"TLS     跳过（http 地址）", "接口    通过", "模型回复「ok」", "结果：高德地图 未配置 · AI 模型 通过 · 天地图 未配置"} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %q in:\n%s", want, s)
		}
	}
	if strings.Contains(s, key) {
		t.Fatalf("the key leaked:\n%s", s)
	}
	status = http.StatusUnauthorized
	out.Reset()
	if code := runDiagnose(&out); code != 1 {
		t.Fatalf("exit %d:\n%s", code, out.String())
	}
	if s := out.String(); !strings.Contains(s, "接口    失败") || !strings.Contains(s, "[http] AI Key 无效或没有权限（HTTP 401") ||
		!strings.Contains(s, "HTTP 状态  401") || strings.Contains(s, key) ||
		!strings.Contains(s, "部署目录的 README.md（源码中为 docs/DEPLOY.md）") {
		t.Fatalf("output:\n%s", s)
	}
	// Credentials in the base URL of a gateway are not printed.
	status = http.StatusOK
	t.Setenv("TRIPHUB_AI_BASE_URL", strings.Replace(srv.URL, "http://", "http://gw-user:gw-t0ken@", 1)+"/v1?key=abc123")
	out.Reset()
	runDiagnose(&out)
	if s := out.String(); strings.Contains(s, "gw-t0ken") || strings.Contains(s, "gw-user") || strings.Contains(s, "abc123") ||
		!strings.Contains(s, "[AI 模型] http://***@127.0.0.1:") {
		t.Fatalf("credentials in the output:\n%s", s)
	}
	t.Setenv("TRIPHUB_AI_BASE_URL", srv.URL)
	// Nothing listens: the layer that failed.
	srv.Close()
	out.Reset()
	if code := runDiagnose(&out); code != 1 {
		t.Fatalf("exit %d:\n%s", code, out.String())
	}
	if s := out.String(); !strings.Contains(s, "TCP     失败") || !strings.Contains(s, "[connect] 无法连接 AI 服务") {
		t.Fatalf("output:\n%s", s)
	}
}
