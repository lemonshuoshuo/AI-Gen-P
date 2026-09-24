package auth

import (
	"strings"
	"sync"
	"sync/atomic"
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

func TestValidatePassword(t *testing.T) {
	for _, pw := range []string{"1", "1234567", "change-me-admin-password", "Change-Me-Admin-Password", "12345678",
		strings.Repeat("a", 65), strings.Repeat("密", 30)} { // 30 characters but 90 bytes (bcrypt uses 72)
		if ValidatePassword(pw) == nil {
			t.Errorf("ValidatePassword(%q) accepted", pw)
		}
	}
	for _, pw := range []string{"secret123", "admin123", "我的密码很安全啊", strings.Repeat("a", 64)} {
		if err := ValidatePassword(pw); err != nil {
			t.Errorf("ValidatePassword(%q): %v", pw, err)
		}
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

func TestLimiterConcurrent(t *testing.T) {
	l := NewLimiter(30, time.Hour)
	start := make(chan struct{})
	var wg sync.WaitGroup
	var allowed atomic.Int64
	for i := 0; i < 500; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if l.Allow("k") {
				allowed.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()
	if n := allowed.Load(); n != 30 {
		t.Fatalf("allowed %d of 500 concurrent hits, want exactly 30", n)
	}
}

func TestLimiterAcquireRelease(t *testing.T) {
	l := NewLimiter(2, time.Minute)
	for i := 0; i < 2; i++ {
		if ok, _ := l.Acquire("k"); !ok {
			t.Fatalf("acquire %d should succeed", i)
		}
	}
	ok, wait := l.Acquire("k")
	if ok || wait <= 0 {
		t.Fatalf("over the limit: ok=%v wait=%v", ok, wait)
	}
	l.Release("k")
	if ok, _ := l.Acquire("k"); !ok {
		t.Fatal("acquire after release should succeed")
	}
	if ok, _ := l.Acquire("k"); ok {
		t.Fatal("the limit is reached again after the released slot was reused")
	}
	l.Release("other") // unknown keys are ignored
}
