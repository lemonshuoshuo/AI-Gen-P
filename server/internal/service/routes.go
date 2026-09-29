package service

import (
	"sort"
	"time"

	"triphub/internal/geo"
	"triphub/internal/model"
)

// PlannedRoute returns the planned stops in seq order. Lodging is not a
// stop of the route: see PlanOrder.
func PlannedRoute(wps []model.Waypoint) []model.Waypoint {
	var out []model.Waypoint
	for _, w := range wps {
		if w.Planned && !w.IsLodging() {
			out = append(out, w)
		}
	}
	sortBySeq(out)
	return out
}

// CountStops counts the waypoints that are stops (not lodging): the
// 打卡点 of a trip's statistics.
func CountStops(wps []model.Waypoint) int {
	n := 0
	for i := range wps {
		if !wps[i].IsLodging() {
			n++
		}
	}
	return n
}

// Lodgings returns the planned lodging of each night (the first by seq, id
// should a night have several).
func Lodgings(wps []model.Waypoint) map[int]*model.Waypoint {
	out := map[int]*model.Waypoint{}
	for i := range wps {
		w := &wps[i]
		if !w.Planned || !w.IsLodging() {
			continue
		}
		if cur := out[w.Day]; cur == nil || w.Seq < cur.Seq || (w.Seq == cur.Seq && w.ID < cur.ID) {
			out[w.Day] = w
		}
	}
	return out
}

// PlanOrder returns the planned waypoints in the order of the plan: the
// stops by seq, and each night's lodging right after the last stop of that
// day (or of the latest earlier day with stops); the night before day 1
// (day 0), and nights before any scheduled stop, come before the first stop
// of a later day. Where a lodging is stored in seq does not matter, so
// clients may keep lodging anywhere in their lists.
func PlanOrder(wps []model.Waypoint) []model.Waypoint {
	stops := PlannedRoute(wps)
	var lodging []model.Waypoint
	for _, w := range wps {
		if w.Planned && w.IsLodging() {
			lodging = append(lodging, w)
		}
	}
	if len(lodging) == 0 {
		return stops
	}
	sort.SliceStable(lodging, func(i, j int) bool {
		a, b := lodging[i], lodging[j]
		if a.Day != b.Day {
			return a.Day < b.Day
		}
		if a.Seq != b.Seq {
			return a.Seq < b.Seq
		}
		return a.ID < b.ID
	})
	// before(n) is how many stops precede the lodging of night n; it does
	// not decrease with n, so the lodging sorted by night merge in order.
	before := func(night int) int {
		after := -1
		for i, s := range stops {
			if s.Day >= 1 && s.Day <= night {
				after = i
			}
		}
		if after >= 0 {
			return after + 1
		}
		for i, s := range stops {
			if s.Day > night {
				return i
			}
		}
		return len(stops)
	}
	out := make([]model.Waypoint, 0, len(stops)+len(lodging))
	li := 0
	for i := 0; i <= len(stops); i++ {
		for li < len(lodging) && before(lodging[li].Day) <= i {
			out = append(out, lodging[li])
			li++
		}
		if i < len(stops) {
			out = append(out, stops[i])
		}
	}
	return out
}

// ActualRoute returns visited waypoints ordered by arrival time when every
// visited point has one, otherwise by seq.
func ActualRoute(wps []model.Waypoint) []model.Waypoint {
	var out []model.Waypoint
	allTimed := true
	for _, w := range wps {
		if w.Status == model.WPVisited {
			out = append(out, w)
			if w.ArrivedAt == nil {
				allTimed = false
			}
		}
	}
	if allTimed {
		sort.SliceStable(out, func(i, j int) bool {
			if !out[i].ArrivedAt.Equal(*out[j].ArrivedAt) {
				return out[i].ArrivedAt.Before(*out[j].ArrivedAt)
			}
			return out[i].Seq < out[j].Seq
		})
	} else {
		sortBySeq(out)
	}
	return out
}

func sortBySeq(wps []model.Waypoint) {
	sort.SliceStable(wps, func(i, j int) bool {
		if wps[i].Seq != wps[j].Seq {
			return wps[i].Seq < wps[j].Seq
		}
		return wps[i].ID < wps[j].ID
	})
}

// RoutePoints converts waypoints to points.
func RoutePoints(wps []model.Waypoint) []geo.Point {
	pts := make([]geo.Point, len(wps))
	for i, w := range wps {
		pts[i] = geo.Point{Lng: w.Lng, Lat: w.Lat}
	}
	return pts
}

// RoutePath converts waypoints to [[lng,lat],…].
func RoutePath(wps []model.Waypoint) [][2]float64 {
	out := make([][2]float64, len(wps))
	for i, w := range wps {
		out[i] = [2]float64{geo.Round(w.Lng, 6), geo.Round(w.Lat, 6)}
	}
	return out
}

// RouteKm returns the polyline length of waypoints in km.
func RouteKm(wps []model.Waypoint) float64 {
	return geo.Round(geo.PathLength(RoutePoints(wps))/1000, 2)
}

// DateOnly truncates a time to its calendar date in loc, returned as UTC midnight.
func DateOnly(t time.Time, loc *time.Location) time.Time {
	t = t.In(loc)
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

// FormatDate formats a date column value.
func FormatDate(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.UTC().Format("2006-01-02")
	return &s
}

// DateSpan is the number of days from start to end (both included); 0
// unless both are set and end is not before start.
func DateSpan(start, end *time.Time) int {
	if start == nil || end == nil {
		return 0
	}
	return max(int(end.UTC().Sub(start.UTC()).Hours()/24)+1, 0)
}

// TripDays computes the number of days of a trip: from its dates when both
// are set; else the days planned (planDays), or the highest waypoint day
// when that is higher (a lodging's night counts as its day); without
// planned days the highest waypoint day, else the span of arrival dates.
func TripDays(start, end *time.Time, planDays int, wps []model.Waypoint, loc *time.Location) int {
	if d := DateSpan(start, end); d > 0 {
		return d
	}
	maxDay := 0
	var first, last time.Time
	for _, w := range wps {
		if w.Day > maxDay {
			maxDay = w.Day
		}
		if w.Status == model.WPVisited && w.ArrivedAt != nil {
			d := DateOnly(*w.ArrivedAt, loc)
			if first.IsZero() || d.Before(first) {
				first = d
			}
			if d.After(last) {
				last = d
			}
		}
	}
	if planDays > 0 {
		return max(planDays, maxDay)
	}
	if maxDay > 0 {
		return maxDay
	}
	if !first.IsZero() {
		return int(last.Sub(first).Hours()/24) + 1
	}
	return 0
}

// DayOfTrip returns the 1-based trip day for time t given a start date (0 if unknown).
func DayOfTrip(start *time.Time, t *time.Time, loc *time.Location) int {
	if start == nil || t == nil {
		return 0
	}
	d := int(DateOnly(*t, loc).Sub(start.UTC()).Hours()/24) + 1
	if d < 1 || d > 366 {
		return 0
	}
	return d
}

func distinctRegions(wps []model.Waypoint) (cities, provinces []string) {
	cities, provinces = []string{}, []string{}
	seenC, seenP := map[string]bool{}, map[string]bool{}
	for _, w := range wps {
		if w.City != "" && !seenC[w.City] {
			seenC[w.City] = true
			cities = append(cities, w.City)
		}
		if w.Province != "" && !seenP[w.Province] {
			seenP[w.Province] = true
			provinces = append(provinces, w.Province)
		}
	}
	return cities, provinces
}

// PlanStats are a trip's statistics as planned: computed from its planned
// stops alone, as if none had been reached yet. Viewers who may not see an
// ongoing trip's progress (Access.HideLive) get these instead of the stored
// ones, which count check-ins, arrivals, photos and the GPS track.
type PlanStats struct {
	Count      int // planned stops
	DistanceKm float64
	Cities     []string
	Provinces  []string
	Days       int
}

// TripPlanStats computes PlanStats from a trip's waypoints (any others than
// the planned ones are ignored); the rules are RecomputeTrip's for a trip
// without check-ins or a track.
func TripPlanStats(start, end *time.Time, planDays int, wps []model.Waypoint, loc *time.Location) PlanStats {
	planned := PlannedRoute(wps) // a copy
	for i := range planned {
		planned[i].Status, planned[i].ArrivedAt = model.WPTodo, nil // no span of arrival dates in Days
	}
	cities, provinces := distinctRegions(planned)
	withLodging := PlanOrder(wps) // a lodging's night counts in Days
	for i := range withLodging {
		withLodging[i].Status, withLodging[i].ArrivedAt = model.WPTodo, nil
	}
	return PlanStats{Count: len(planned), DistanceKm: RouteKm(planned), Cities: cities, Provinces: provinces,
		Days: TripDays(start, end, planDays, withLodging, loc)}
}
