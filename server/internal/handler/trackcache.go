package handler

import (
	"container/list"
	"sync"
	"time"
)

const (
	// trackCacheBytes bounds the memory held by cached track renders.
	trackCacheBytes = 32 << 20
	// trackRenderMaxAge: renders that took longer than this are not cached,
	// and dropTrip records older than this are forgotten.
	trackRenderMaxAge = time.Minute
)

// trackKey identifies one rendering of a trip's track.
type trackKey struct {
	trip   int64
	points int // the trip's track_point_count when rendered
	budget int // point budget (one of trackTiers)
}

type trackEntry struct {
	key  trackKey
	data []byte
}

// trackCache is a small LRU of rendered GET /trips/:id/track payloads,
// bounded by their total size. Writers call dropTrip after changing a trip's
// points; a render that started before the latest drop is not stored.
type trackCache struct {
	mu      sync.Mutex
	max     int
	size    int
	ll      *list.List // front = most recently used
	items   map[trackKey]*list.Element
	dropped map[int64]time.Time // trip → time of its latest dropTrip
}

func newTrackCache(maxBytes int) *trackCache {
	return &trackCache{max: maxBytes, ll: list.New(), items: map[trackKey]*list.Element{}, dropped: map[int64]time.Time{}}
}

func (tc *trackCache) get(k trackKey) ([]byte, bool) {
	tc.mu.Lock()
	defer tc.mu.Unlock()
	e, ok := tc.items[k]
	if !ok {
		return nil, false
	}
	tc.ll.MoveToFront(e)
	return e.Value.(*trackEntry).data, true
}

// put stores a render that was started at since (before the trip was loaded).
func (tc *trackCache) put(k trackKey, data []byte, since time.Time) {
	if len(data) > tc.max/8 || time.Since(since) > trackRenderMaxAge {
		return
	}
	tc.mu.Lock()
	defer tc.mu.Unlock()
	if at, ok := tc.dropped[k.trip]; ok && !at.Before(since) {
		return // the track changed while it was being rendered
	}
	if e, ok := tc.items[k]; ok {
		tc.remove(e)
	}
	tc.items[k] = tc.ll.PushFront(&trackEntry{key: k, data: data})
	tc.size += len(data)
	for tc.size > tc.max {
		tc.remove(tc.ll.Back())
	}
}

func (tc *trackCache) remove(e *list.Element) {
	ent := tc.ll.Remove(e).(*trackEntry)
	delete(tc.items, ent.key)
	tc.size -= len(ent.data)
}

// dropTrip forgets the renders of a trip whose points changed.
func (tc *trackCache) dropTrip(trip int64) {
	tc.mu.Lock()
	defer tc.mu.Unlock()
	now := time.Now()
	tc.dropped[trip] = now
	if len(tc.dropped) > 1024 {
		for id, at := range tc.dropped {
			if now.Sub(at) > trackRenderMaxAge {
				delete(tc.dropped, id)
			}
		}
	}
	for e := tc.ll.Front(); e != nil; {
		next := e.Next()
		if e.Value.(*trackEntry).key.trip == trip {
			tc.remove(e)
		}
		e = next
	}
}
