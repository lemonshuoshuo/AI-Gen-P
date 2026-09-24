package handler

import (
	"testing"
	"time"

	"triphub/internal/model"
)

func planned(id int64, seq int, lng, lat float64, status string) model.Waypoint {
	return model.Waypoint{ID: id, Seq: seq, Planned: true, Status: status, Lng: lng, Lat: lat}
}

func TestNearestTodo(t *testing.T) {
	// Three shops 87–134 m apart: the one reached wins, not the lowest seq.
	shops := []model.Waypoint{
		planned(1, 3, 104.05300, 30.66900, model.WPTodo),
		planned(2, 4, 104.05440, 30.66910, model.WPTodo),
		planned(3, 5, 104.05370, 30.66960, model.WPTodo),
	}
	if w := nearestTodo(shops, 104.05445, 30.66910, checkinMatchRadius); w == nil || w.Seq != 4 {
		t.Fatalf("shops: %+v", w)
	}
	// Two stops ~3 m apart (the hotel at the start and end of a day) are the same spot: lowest seq.
	hotel := []model.Waypoint{
		planned(1, 0, 120.15000, 30.26, model.WPTodo),
		planned(2, 9, 120.15003, 30.26, model.WPTodo),
	}
	if w := nearestTodo(hotel, 120.15003, 30.26, checkinMatchRadius); w == nil || w.Seq != 0 {
		t.Fatalf("hotel: %+v", w)
	}
	// Visited, skipped and unplanned stops are not candidates; nothing within 200 m gives nil.
	done := []model.Waypoint{
		planned(1, 0, 120.15, 30.26, model.WPVisited),
		planned(2, 1, 120.15, 30.26, model.WPSkipped),
		{ID: 3, Seq: 2, Status: model.WPVisited, Lng: 120.15, Lat: 30.26},
		planned(4, 3, 120.16, 30.26, model.WPTodo), // ~960 m away
	}
	if w := nearestTodo(done, 120.15, 30.26, checkinMatchRadius); w != nil {
		t.Fatalf("nothing should match: %+v", w)
	}
}

func TestCheckinTarget(t *testing.T) {
	now := time.Now()
	at := func(d time.Duration) *time.Time {
		v := now.Add(d)
		return &v
	}
	// Planned shop A (visited a minute ago) and B (todo) about 90 m east of it.
	a := planned(1, 0, 120.15130, 30.26100, model.WPVisited)
	a.Name, a.AmapID, a.ArrivedAt = "面馆", "B0A", at(-time.Minute)
	b := planned(2, 1, 120.15224, 30.26100, model.WPTodo)
	wps := []model.Waypoint{a, b}

	// A repeated tap (or the partner's) at A repeats the visit; B is not marked.
	if w, dup := checkinTarget(wps, 120.15132, 30.26101, now, "", ""); !dup || w == nil || w.ID != 1 {
		t.Fatalf("repeat at A: %+v %v", w, dup)
	}
	if w, dup := checkinTarget(wps, 120.15132, 30.26101, now, "", "B0A"); !dup || w.ID != 1 {
		t.Fatalf("repeat with amap_id: %+v %v", w, dup)
	}
	// Walking on to B: the closer todo stop wins.
	if w, dup := checkinTarget(wps, 120.15220, 30.26100, now, "", ""); dup || w == nil || w.ID != 2 {
		t.Fatalf("arrive at B: %+v %v", w, dup)
	}
	// Without B nearby: a different, named shop 20 m from A is a new stop.
	onlyA := wps[:1]
	if w, dup := checkinTarget(onlyA, 120.15150, 30.26100, now, "奶茶店", ""); dup || w != nil {
		t.Fatalf("named shop: %+v %v", w, dup)
	}
	if w, dup := checkinTarget(onlyA, 120.15150, 30.26100, now, "", "B0OTHER"); dup || w != nil {
		t.Fatalf("other POI: %+v %v", w, dup)
	}
	// The same name repeats the visit.
	if w, dup := checkinTarget(onlyA, 120.15150, 30.26100, now, "面馆", ""); !dup || w.ID != 1 {
		t.Fatalf("same name: %+v %v", w, dup)
	}
	// A back-filled arrival hours earlier, or a visit long ago, is not a repeat.
	if w, dup := checkinTarget(onlyA, 120.15132, 30.26101, now.Add(-3*time.Hour), "", ""); dup || w != nil {
		t.Fatalf("back-filled: %+v %v", w, dup)
	}
	wps[0].ArrivedAt = at(-time.Hour)
	if w, dup := checkinTarget(wps, 120.15132, 30.26101, now, "", ""); dup || w == nil || w.ID != 2 {
		t.Fatalf("old visit: %+v %v", w, dup)
	}
}
