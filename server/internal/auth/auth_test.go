package auth

import (
	"testing"
	"time"
)

func TestTokens(t *testing.T) {
	tk := NewTokens("secret-a")
	s, err := tk.IssueAccess(42, 7)
	if err != nil {
		t.Fatal(err)
	}
	uid, sid, err := tk.ParseAccess(s)
	if err != nil || uid != 42 || sid != 7 {
		t.Fatalf("parse: %d %d %v", uid, sid, err)
	}
	if _, _, err := NewTokens("secret-b").ParseAccess(s); err == nil {
		t.Fatal("token signed with another secret accepted")
	}
	if _, _, err := tk.ParseAccess("garbage"); err == nil {
		t.Fatal("garbage accepted")
	}
	plain, hash := NewRefreshToken()
	if HashToken(plain) != hash || len(hash) != 64 {
		t.Fatal("refresh hash")
	}
	if c := RandomBase62(10); len(c) != 10 {
		t.Fatal("share code length")
	}
}

func TestPassword(t *testing.T) {
	h, err := HashPassword("secret123")
	if err != nil || !CheckPassword(h, "secret123") || CheckPassword(h, "wrong") || CheckPassword("", "secret123") {
		t.Fatal("password check")
	}
}

func TestLimiter(t *testing.T) {
	l := NewLimiter(2, time.Minute)
	if !l.Allow("k") || !l.Allow("k") || l.Allow("k") {
		t.Fatal("limiter should allow exactly 2")
	}
	if blocked, wait := l.Blocked("k"); !blocked || wait <= 0 {
		t.Fatal("should be blocked")
	}
	l.Reset("k")
	if !l.Allow("k") {
		t.Fatal("reset")
	}
}
