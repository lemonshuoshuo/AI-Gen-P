package config

import (
	"encoding/hex"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
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
