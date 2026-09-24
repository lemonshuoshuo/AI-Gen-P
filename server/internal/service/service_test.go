package service

import (
	"testing"
	"time"

	"triphub/internal/model"
)

func tp(s string) *time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return &t
}

func TestLevelFor(t *testing.T) {
	cases := []struct {
		exp, level int
		next       int // 0 = nil
	}{{0, 1, 50}, {49, 1, 50}, {50, 2, 200}, {599, 3, 600}, {4000, 6, 0}, {99999, 6, 0}}
	for _, c := range cases {
		l, next := LevelFor(c.exp)
		if l.Level != c.level || (c.next == 0) != (next == nil) || (next != nil && *next != c.next) {
			t.Errorf("LevelFor(%d) = %d,%v", c.exp, l.Level, next)
		}
	}
	if QuotaBytes(&model.User{Exp: 60}) != 1<<30 || QuotaBytes(&model.User{Role: model.RoleAdmin}) != 0 {
		t.Error("quota")
	}
}

func TestActualRoute(t *testing.T) {
	wps := []model.Waypoint{
		{ID: 1, Seq: 0, Planned: true, Status: model.WPVisited, ArrivedAt: tp("2026-05-01T12:00:00+08:00")},
		{ID: 2, Seq: 1, Planned: true, Status: model.WPSkipped},
		{ID: 3, Seq: 2, Planned: false, Status: model.WPVisited, ArrivedAt: tp("2026-05-01T10:00:00+08:00")},
		{ID: 4, Seq: 3, Planned: true, Status: model.WPTodo},
	}
	got := ActualRoute(wps)
	if len(got) != 2 || got[0].ID != 3 || got[1].ID != 1 {
		t.Fatalf("expected arrival order [3 1], got %v", got)
	}
	wps[2].ArrivedAt = nil // not all timed → seq order
	got = ActualRoute(wps)
	if got[0].ID != 1 || got[1].ID != 3 {
		t.Fatalf("expected seq order [1 3], got %v", got)
	}
	if p := PlannedRoute(wps); len(p) != 3 || p[2].ID != 4 {
		t.Fatalf("planned route %v", p)
	}
}

func TestChronoInsertSeq(t *testing.T) {
	wps := []model.Waypoint{
		{Seq: 0, ArrivedAt: tp("2026-05-01T09:00:00+08:00")},
		{Seq: 1},
		{Seq: 2, ArrivedAt: tp("2026-05-01T15:00:00+08:00")},
	}
	if s := ChronoInsertSeq(wps, tp("2026-05-01T12:00:00+08:00")); s == nil || *s != 1 {
		t.Fatalf("midday → 1, got %v", s)
	}
	if s := ChronoInsertSeq(wps, tp("2026-05-01T08:00:00+08:00")); s == nil || *s != 0 {
		t.Fatalf("early → 0, got %v", s)
	}
	if s := ChronoInsertSeq(wps, tp("2026-05-02T08:00:00+08:00")); s == nil || *s != 3 {
		t.Fatalf("late → 3, got %v", s)
	}
	if s := ChronoInsertSeq(wps, nil); s != nil {
		t.Fatal("nil time → append")
	}
	if s := ChronoInsertSeq([]model.Waypoint{{Seq: 0}}, tp("2026-05-01T08:00:00+08:00")); s != nil {
		t.Fatal("no timed waypoints → append")
	}
}

func TestTripDays(t *testing.T) {
	loc, _ := time.LoadLocation("Asia/Shanghai")
	d := func(s string) *time.Time { v, _ := time.Parse("2006-01-02", s); return &v }
	if n := TripDays(d("2026-05-01"), d("2026-05-03"), nil, loc); n != 3 {
		t.Errorf("dates: %d", n)
	}
	if n := TripDays(nil, nil, []model.Waypoint{{Day: 2}, {Day: 4}}, loc); n != 4 {
		t.Errorf("max day: %d", n)
	}
	wps := []model.Waypoint{
		{Status: model.WPVisited, ArrivedAt: tp("2026-05-01T23:30:00+08:00")},
		{Status: model.WPVisited, ArrivedAt: tp("2026-05-02T00:30:00+08:00")},
	}
	if n := TripDays(nil, nil, wps, loc); n != 2 {
		t.Errorf("arrival span (local dates): %d", n)
	}
	if n := DayOfTrip(d("2026-05-01"), tp("2026-05-02T01:00:00+08:00"), loc); n != 2 {
		t.Errorf("day of trip: %d", n)
	}
}

func TestRecommendHelpers(t *testing.T) {
	loc, _ := time.LoadLocation("Asia/Shanghai")
	noon := time.Date(2026, 5, 1, 12, 0, 0, 0, loc)
	p, _ := dayPeriod(noon)
	if p != "meal" || timeBoost(p, "food") <= timeBoost(p, "scenic") {
		t.Errorf("noon should favour food: %s", p)
	}
	night := time.Date(2026, 5, 1, 23, 0, 0, 0, loc)
	if p, _ := dayPeriod(night); p != "night" || timeBoost(p, "hotel") <= 0 {
		t.Errorf("night period %s", p)
	}
	if FormatDistance(423) != "420 米" || FormatDistance(1234) != "1.2 公里" {
		t.Errorf("format distance: %s %s", FormatDistance(423), FormatDistance(1234))
	}
	cands := []Suggestion{{Source: "plan"}, {Source: "plan"}, {Source: "plan"}, {Source: "community"}}
	if got := pickRuleBased(cands, 5); len(got) != 3 || got[2].Source != "community" {
		t.Errorf("pickRuleBased: %v", got)
	}
}

func TestGeoInfoAutoName(t *testing.T) {
	if n := (GeoInfo{District: "西湖区", Street: "北山街道", City: "杭州市"}).AutoName(); n != "西湖区·北山街道" {
		t.Error(n)
	}
	if n := (GeoInfo{City: "杭州市"}).AutoName(); n != "杭州市" {
		t.Error(n)
	}
	if n := (GeoInfo{}).AutoName(); n != "未命名地点" {
		t.Error(n)
	}
}
