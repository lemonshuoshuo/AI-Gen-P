package auth

import (
	"sync"
	"time"
)

// Limiter is a fixed-window counter keyed by string (e.g. IP+account).
// It is used to throttle failed logins and other abuse-prone actions.
type Limiter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	m      map[string]*window
}

type window struct {
	count int
	reset time.Time
}

// NewLimiter allows at most max hits per window for each key.
func NewLimiter(max int, per time.Duration) *Limiter {
	return &Limiter{max: max, window: per, m: map[string]*window{}}
}

// Blocked reports whether the key is over its limit, and when it resets.
func (l *Limiter) Blocked(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	w, ok := l.m[key]
	now := time.Now()
	if !ok || now.After(w.reset) {
		return false, 0
	}
	if w.count >= l.max {
		return true, w.reset.Sub(now)
	}
	return false, 0
}

// Hit records one event for the key.
func (l *Limiter) Hit(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	w, ok := l.m[key]
	if !ok || now.After(w.reset) {
		w = &window{reset: now.Add(l.window)}
		l.m[key] = w
	}
	w.count++
}

// Allow records a hit and reports whether it was within the limit.
func (l *Limiter) Allow(key string) bool {
	if blocked, _ := l.Blocked(key); blocked {
		return false
	}
	l.Hit(key)
	return true
}

// Reset clears the key.
func (l *Limiter) Reset(key string) {
	l.mu.Lock()
	delete(l.m, key)
	l.mu.Unlock()
}

// Cleanup removes expired windows; call periodically.
func (l *Limiter) Cleanup() {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	for k, w := range l.m {
		if now.After(w.reset) {
			delete(l.m, k)
		}
	}
}
