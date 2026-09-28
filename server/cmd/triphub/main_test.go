package main

import "testing"

func TestHealthURL(t *testing.T) {
	for addr, want := range map[string]string{
		":8080":          "http://127.0.0.1:8080/api/v1/health",
		"0.0.0.0:9000":   "http://127.0.0.1:9000/api/v1/health",
		"[::]:8080":      "http://127.0.0.1:8080/api/v1/health",
		"127.0.0.1:8081": "http://127.0.0.1:8081/api/v1/health",
		"[::1]:8080":     "http://[::1]:8080/api/v1/health",
		"":               "http://127.0.0.1:8080/api/v1/health",
		" :8080 ":        "http://127.0.0.1:8080/api/v1/health",
	} {
		if got := healthURL(addr); got != want {
			t.Errorf("healthURL(%q) = %q, want %q", addr, got, want)
		}
	}
}
