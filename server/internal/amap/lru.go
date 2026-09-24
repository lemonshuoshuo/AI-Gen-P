package amap

import (
	"container/list"
	"sync"
	"time"
)

// lru is a small thread-safe LRU cache with per-entry TTL.
type lru[V any] struct {
	mu    sync.Mutex
	cap   int
	ttl   time.Duration
	ll    *list.List
	items map[string]*list.Element
}

type lruEntry[V any] struct {
	key     string
	val     V
	expires time.Time
}

func newLRU[V any](capacity int, ttl time.Duration) *lru[V] {
	return &lru[V]{cap: capacity, ttl: ttl, ll: list.New(), items: map[string]*list.Element{}}
}

func (c *lru[V]) Get(key string) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var zero V
	el, ok := c.items[key]
	if !ok {
		return zero, false
	}
	e := el.Value.(*lruEntry[V])
	if time.Now().After(e.expires) {
		c.ll.Remove(el)
		delete(c.items, key)
		return zero, false
	}
	c.ll.MoveToFront(el)
	return e.val, true
}

func (c *lru[V]) Put(key string, v V) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[key]; ok {
		e := el.Value.(*lruEntry[V])
		e.val, e.expires = v, time.Now().Add(c.ttl)
		c.ll.MoveToFront(el)
		return
	}
	c.items[key] = c.ll.PushFront(&lruEntry[V]{key: key, val: v, expires: time.Now().Add(c.ttl)})
	for c.ll.Len() > c.cap {
		last := c.ll.Back()
		c.ll.Remove(last)
		delete(c.items, last.Value.(*lruEntry[V]).key)
	}
}
