package config

import (
	"encoding/hex"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestTrustedProxies(t *testing.T) {
	t.Setenv("TRIPHUB_TRUSTED_PROXIES", "")
	c, err := Load()
	if err != nil || !slices.Equal(c.TrustedProxies, defaultTrustedProxies) {
		t.Fatalf("default: %v %v", c, err)
	}
	for _, v := range []string{"none", " NONE "} {
		t.Setenv("TRIPHUB_TRUSTED_PROXIES", v)
		if c, err := Load(); err != nil || c.TrustedProxies == nil || len(c.TrustedProxies) != 0 {
			t.Fatalf("%q: %v %v", v, c, err)
		}
	}
	t.Setenv("TRIPHUB_TRUSTED_PROXIES", "10.0.0.5, 172.18.0.0/16,,::1")
	if c, err := Load(); err != nil || !slices.Equal(c.TrustedProxies, []string{"10.0.0.5", "172.18.0.0/16", "::1"}) {
		t.Fatalf("list: %v %v", c, err)
	}
	t.Setenv("TRIPHUB_TRUSTED_PROXIES", "10.0.0.5,abc")
	if _, err := Load(); err == nil {
		t.Fatal("invalid entry accepted")
	}
}

func TestJWTSecret(t *testing.T) {
	short := &Config{DataDir: t.TempDir(), JWTSecret: "x"}
	if err := short.Prepare(); err == nil {
		t.Fatal("a 1-character JWT secret was accepted")
	}
	long := &Config{DataDir: t.TempDir(), JWTSecret: strings.Repeat("k", 40)}
	if err := long.Prepare(); err != nil || long.JWTSecret != strings.Repeat("k", 40) {
		t.Fatalf("40-character secret: %v", err)
	}
	// Whitespace-only counts as unset.
	t.Setenv("TRIPHUB_JWT_SECRET", "  ")
	c, err := Load()
	if err != nil || c.JWTSecret != "" {
		t.Fatalf("blank secret: %q %v", c.JWTSecret, err)
	}
	// Unset: generated once, stored in DATA_DIR/jwt_secret and reused.
	dir := t.TempDir()
	gen := &Config{DataDir: dir}
	if err := gen.Prepare(); err != nil {
		t.Fatal(err)
	}
	if _, err := hex.DecodeString(gen.JWTSecret); err != nil || len(gen.JWTSecret) != 64 {
		t.Fatalf("generated secret %q: %v", gen.JWTSecret, err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "jwt_secret"))
	if err != nil || strings.TrimSpace(string(b)) != gen.JWTSecret {
		t.Fatalf("stored secret: %q %v", b, err)
	}
	again := &Config{DataDir: dir}
	if err := again.Prepare(); err != nil || again.JWTSecret != gen.JWTSecret {
		t.Fatalf("secret not reused: %v", err)
	}
}

// Values copied into .env often carry stray spaces.
func TestNumbersTrimmed(t *testing.T) {
	t.Setenv("TRIPHUB_MAX_UPLOAD_MB", " 30 ")
	t.Setenv("TRIPHUB_AI_TIMEOUT", " 90s\t")
	c, err := Load()
	if err != nil || c.MaxUploadMB != 30 || c.AITimeout != 90*time.Second {
		t.Fatalf("trimmed values: %+v %v", c, err)
	}
	t.Setenv("TRIPHUB_AI_TIMEOUT", " 120 ")
	if c, err := Load(); err != nil || c.AITimeout != 120*time.Second {
		t.Fatalf("seconds with spaces: %v %v", c.AITimeout, err)
	}
	t.Setenv("TRIPHUB_MAX_UPLOAD_MB", "  ")
	if c, err := Load(); err != nil || c.MaxUploadMB != 20 {
		t.Fatalf("blank upload limit: %v %v", c.MaxUploadMB, err)
	}
	t.Setenv("TRIPHUB_AI_TIMEOUT", "soon")
	if _, err := Load(); err == nil {
		t.Fatal("invalid timeout accepted")
	}
}

func TestAIOptions(t *testing.T) {
	for _, k := range []string{"TRIPHUB_AI_THINKING", "TRIPHUB_AI_EXTRA_BODY", "TRIPHUB_AI_TIMEOUT", "TRIPHUB_TIANDITU_KEY"} {
		t.Setenv(k, "")
	}
	c, err := Load()
	if err != nil || c.AIThinking != "off" || c.AIExtraBody != nil || c.AITimeout != 120*time.Second || c.TiandituKey != "" {
		t.Fatalf("defaults: %+v %v", c, err)
	}
	for in, want := range map[string]string{"on": "on", " HIGH ": "high", "low": "low", "max": "max", "false": "off", "disabled": "off", "true": "on"} {
		t.Setenv("TRIPHUB_AI_THINKING", in)
		if c, err := Load(); err != nil || c.AIThinking != want {
			t.Fatalf("thinking %q: %q %v", in, c.AIThinking, err)
		}
	}
	t.Setenv("TRIPHUB_AI_THINKING", "maybe")
	if _, err := Load(); err == nil {
		t.Fatal("invalid thinking mode accepted")
	}
	t.Setenv("TRIPHUB_AI_THINKING", "")
	t.Setenv("TRIPHUB_AI_EXTRA_BODY", ` {"enable_thinking": false, "top_p": 0.8} `)
	if c, err := Load(); err != nil || c.AIExtraBody["enable_thinking"] != false || c.AIExtraBody["top_p"] != 0.8 {
		t.Fatalf("extra body: %v %v", c.AIExtraBody, err)
	}
	for _, bad := range []string{"[1]", "{not json", "null", `"x"`} {
		t.Setenv("TRIPHUB_AI_EXTRA_BODY", bad)
		if _, err := Load(); err == nil {
			t.Fatalf("extra body %q accepted", bad)
		}
	}
	t.Setenv("TRIPHUB_AI_EXTRA_BODY", "")
	t.Setenv("TRIPHUB_TIANDITU_KEY", " tk ")
	if c, err := Load(); err != nil || c.TiandituKey != "tk" {
		t.Fatalf("tianditu key: %q %v", c.TiandituKey, err)
	}
}

func TestCleanValue(t *testing.T) {
	const key = "c549b0e3a1d24f6c8e7b9a0d1c2e3f4a"
	for _, tc := range []struct {
		in, want string
		removed  string
	}{
		{key, key, ""},
		{"  " + key + " ", key, "首尾空白"},
		{`"` + key + `"`, key, "首尾引号"},
		{`'` + key + `'`, key, "首尾引号"},
		{"“" + key + "”", key, "首尾引号"},
		{`"` + key + `" # 测试 key`, key, "首尾引号、行尾注释"},
		{`"abc # not a comment"`, "abc # not a comment", "首尾引号"},
		{key + "\t# 测试", key, "行尾注释"},
		{key + " #comment", key, "行尾注释"},
		{"abc#def", "abc#def", ""},
		{"\ufeff" + key + "\u200b", key, "BOM / 零宽字符"},
		{key + "\r\n", key, "换行符"},
		{"\u2060sk-" + key + "\u200c\u200d", "sk-" + key, "BOM / 零宽字符"},
		{`"https://api.deepseek.com"  # DeepSeek`, "https://api.deepseek.com", "首尾引号、行尾注释"},
		{"https://example.com/v1#frag", "https://example.com/v1#frag", ""},
		{`"unterminated`, `"unterminated`, ""},
		{"", "", ""},
	} {
		got, removed := cleanValue(tc.in)
		if got != tc.want || strings.Join(removed, "、") != tc.removed {
			t.Errorf("cleanValue(%q) = %q %v, want %q %q", tc.in, got, removed, tc.want, tc.removed)
		}
	}
}

func TestLoadCleansKeys(t *testing.T) {
	const key = "c549b0e3a1d24f6c8e7b9a0d1c2e3f4a"
	t.Setenv("TRIPHUB_AMAP_KEY", `"`+key+`"	# 高德`)
	t.Setenv("TRIPHUB_AI_API_KEY", "sk-0123456789abcdef0123456789abcdef\u200b")
	t.Setenv("TRIPHUB_AI_BASE_URL", " 'https://api.deepseek.com/' ")
	t.Setenv("TRIPHUB_AI_MODEL", "deepseek-flash\r")
	t.Setenv("TRIPHUB_TIANDITU_KEY", key)
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.AmapKey != key || c.AIAPIKey != "sk-0123456789abcdef0123456789abcdef" || c.AIBaseURL != "https://api.deepseek.com" ||
		c.AIModel != "deepseek-flash" || c.TiandituKey != key {
		t.Fatalf("cleaned: %q %q %q %q %q", c.AmapKey, c.AIAPIKey, c.AIBaseURL, c.AIModel, c.TiandituKey)
	}
	var vars []string
	for _, cl := range c.Cleaned {
		vars = append(vars, cl.Var)
	}
	if strings.Join(vars, ",") != "TRIPHUB_AMAP_KEY,TRIPHUB_AI_BASE_URL,TRIPHUB_AI_API_KEY,TRIPHUB_AI_MODEL" {
		t.Fatalf("cleaned vars: %v", c.Cleaned)
	}
	hints := c.KeyHints()
	if len(hints) != 3 || hints[0].Hint.Text != "长度 32 · c549…3f4a" || hints[1].Hint.Warning != "" || hints[1].Hint.Length != 35 {
		t.Fatalf("hints: %+v", hints)
	}
	for _, h := range hints {
		if strings.Contains(h.Hint.Text, key) {
			t.Fatalf("a key leaked into its hint: %+v", h)
		}
	}
}
