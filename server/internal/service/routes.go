package service

import (
	"sort"
	"time"

	"triphub/internal/geo"
	"triphub/internal/model"
)

// PlannedRoute returns planned waypoints in seq order.
func PlannedRoute(wps []model.Waypoint) []model.Waypoint {
	var out []model.Waypoint
	for _, w := range wps {
		if w.Planned {
			out = append(out, w)
		}
	}
	sortBySeq(out)
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

// TripDays computes the number of days of a trip: from its dates when both
// are set, else the highest waypoint day, else the span of arrival dates.
func TripDays(start, end *time.Time, wps []model.Waypoint, loc *time.Location) int {
	if start != nil && end != nil {
		d := int(end.UTC().Sub(start.UTC()).Hours()/24) + 1
		if d > 0 {
			return d
		}
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
