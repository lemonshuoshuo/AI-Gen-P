package service

import (
	"context"
	"errors"
	"math"
	"slices"
	"sync"
	"time"

	"triphub/internal/amap"
	"triphub/internal/geo"
	"triphub/internal/model"
)

// LegModes are the travel modes of TripLegs.
var LegModes = []string{"walking", "transit", "driving"}

// Leg is the way between two consecutive planned stops of the same day.
type Leg struct {
	FromID    int64  `json:"from_id"`
	ToID      int64  `json:"to_id"`
	Day       int    `json:"day"`
	Mode      string `json:"mode"` // the mode used: short transit legs are walked
	DistanceM int    `json:"distance_m"`
	DurationS int    `json:"duration_s"`
	StraightM int    `json:"straight_m"`
	Estimated bool   `json:"estimated"` // estimated from the straight line, not planned by 高德
}

// DayLegs sums the legs of one day.
type DayLegs struct {
	Day       int  `json:"day"`
	Stops     int  `json:"stops"`
	DistanceM int  `json:"distance_m"`
	DurationS int  `json:"duration_s"`
	Estimated bool `json:"estimated"` // some leg is estimated
}

// TripLegsResult is the result of TripLegs.
type TripLegsResult struct {
	Mode string    `json:"mode"`
	Legs []Leg     `json:"legs"`
	Days []DayLegs `json:"days"`
}

const (
	legsWorkers = 3
	legMinAmapM = 50.0   // shorter legs are the same spot: not worth a request
	shortTransM = 1000.0 // public transport legs up to this far are walked
)

// legsBudget is the time for all 高德 requests of one TripLegs call.
var legsBudget = 4 * time.Second

// legMaxAmapM is the longest straight-line leg planned by 高德 per mode;
// longer ones are estimated.
var legMaxAmapM = map[string]float64{"walking": 30000, "transit": 150000, "driving": 1000000}

// estimateLeg estimates a leg from its straight-line distance in metres:
// the way is 30 % (driving 40 %) longer; walking at 1.2 m/s; public transport
// at 6 m/s plus 10 minutes of walking and waiting; driving at 8 m/s plus 3
// minutes. Over 50 km (between cities: trains, coaches, highways) both
// average 20 m/s.
func estimateLeg(mode string, straight float64) Leg {
	var dist, dur float64
	intercity := straight > 50000
	switch {
	case mode == "driving":
		dist = 1.4 * straight
		speed := 8.0
		if intercity {
			speed = 20
		}
		dur = 180 + dist/speed
	case mode == "transit" && straight > shortTransM:
		dist = 1.3 * straight
		speed := 6.0
		if intercity {
			speed = 20
		}
		dur = 600 + dist/speed
	default:
		mode = "walking"
		dist = 1.3 * straight
		dur = dist / 1.2
	}
	return Leg{Mode: mode, DistanceM: int(math.Round(dist)), DurationS: int(math.Round(dur)),
		StraightM: int(math.Round(straight)), Estimated: true}
}

// TripLegs returns the legs between consecutive planned stops of the same
// day (none across days) and the totals of each day, day 0 (未分天) last.
// Legs are planned by 高德 when it is configured and answers in time,
// otherwise estimated (see estimateLeg).
func (s *Service) TripLegs(ctx context.Context, wps []model.Waypoint, mode string) TripLegsResult {
	route := PlannedRoute(wps)
	res := TripLegsResult{Mode: mode, Legs: []Leg{}, Days: []DayLegs{}}
	var ends [][2]*model.Waypoint // the stops of each leg
	for i := 1; i < len(route); i++ {
		a, b := &route[i-1], &route[i]
		if a.Day != b.Day {
			continue
		}
		l := estimateLeg(mode, geo.Haversine(a.Lng, a.Lat, b.Lng, b.Lat))
		l.FromID, l.ToID, l.Day = a.ID, b.ID, a.Day
		res.Legs = append(res.Legs, l)
		ends = append(ends, [2]*model.Waypoint{a, b})
	}
	s.planLegs(ctx, mode, res.Legs, ends)

	days := map[int]*DayLegs{}
	for _, w := range route {
		d := days[w.Day]
		if d == nil {
			d = &DayLegs{Day: w.Day}
			days[w.Day] = d
		}
		d.Stops++
	}
	for _, l := range res.Legs {
		d := days[l.Day]
		d.DistanceM += l.DistanceM
		d.DurationS += l.DurationS
		d.Estimated = d.Estimated || l.Estimated
	}
	for _, d := range days {
		res.Days = append(res.Days, *d)
	}
	slices.SortFunc(res.Days, func(a, b DayLegs) int {
		if (a.Day == 0) != (b.Day == 0) {
			if a.Day == 0 {
				return 1
			}
			return -1
		}
		return a.Day - b.Day
	})
	return res
}

// planLegs replaces the estimates of legs by 高德 routes, from legsWorkers
// workers within legsBudget. Legs 高德 does not answer in time keep their
// estimates; answers are cached, so later calls fill in more of them.
func (s *Service) planLegs(ctx context.Context, mode string, legs []Leg, ends [][2]*model.Waypoint) {
	if !s.Amap.Enabled() || len(legs) == 0 {
		return
	}
	// The budget cancels the context instead of letting it expire: a request
	// cut short by it says nothing about 高德's health, so it must not open
	// the client's circuit breaker as a timed-out request does.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	budget := time.AfterFunc(legsBudget, cancel)
	defer budget.Stop()
	jobs := make(chan int)
	var wg sync.WaitGroup
	for range legsWorkers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				if r := s.planLeg(ctx, mode, ends[i][0], ends[i][1], float64(legs[i].StraightM)); r != nil {
					legs[i].Mode, legs[i].DistanceM, legs[i].DurationS, legs[i].Estimated = r.Mode, r.DistanceM, r.DurationS, false
				}
			}
		}()
	}
	for i := range legs {
		if straight := float64(legs[i].StraightM); straight >= legMinAmapM && straight <= legMaxAmapM[mode] {
			jobs <- i
		}
	}
	close(jobs)
	wg.Wait()
}

// planLeg asks 高德 for the route of one leg; nil keeps the estimate. Public
// transport needs the cities of both stops; short legs, and legs without
// public transport, are walked.
func (s *Service) planLeg(ctx context.Context, mode string, a, b *model.Waypoint, straight float64) *amap.Route {
	if mode == "transit" && straight > shortTransM {
		city, cityd := s.legCity(a), s.legCity(b)
		if city == "" || cityd == "" {
			return nil
		}
		r, err := s.Amap.Direction(ctx, mode, a.Lng, a.Lat, b.Lng, b.Lat, city, cityd)
		if err == nil {
			return r
		}
		if !errors.Is(err, amap.ErrNoRoute) {
			return nil
		}
	}
	if mode == "transit" {
		mode = "walking"
		if straight > legMaxAmapM[mode] {
			return nil
		}
	}
	r, err := s.Amap.Direction(ctx, mode, a.Lng, a.Lat, b.Lng, b.Lat, "", "")
	if err != nil {
		return nil
	}
	return r
}

// legCity is the city of a stop for 高德's public transport planning.
func (s *Service) legCity(w *model.Waypoint) string {
	if w.City != "" {
		return w.City
	}
	if loc, ok := s.Atlas.LookupGCJ(w.Lng, w.Lat); ok {
		return loc.City
	}
	return ""
}
