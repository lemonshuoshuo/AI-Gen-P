package service

import (
	"context"
	"errors"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"triphub/internal/amap"
	"triphub/internal/geo"
	"triphub/internal/model"
)

// LegModes are the modes of TripLegs: "auto" takes each leg's recommended
// mode (see RecommendMode), the others every leg's.
var LegModes = model.TravelModes

// Leg is the way between two consecutive points of a day's route: the
// lodging it starts from, its stops, the lodging it ends at.
type Leg struct {
	FromID int64 `json:"from_id"`
	ToID   int64 `json:"to_id"`
	Day    int   `json:"day"`
	// Mode is the mode used: the recommended one in auto mode; short
	// transit legs are walked.
	Mode            string `json:"mode"`
	RecommendedMode string `json:"recommended_mode"`
	DistanceM       int    `json:"distance_m"`
	DurationS       int    `json:"duration_s"`
	StraightM       int    `json:"straight_m"`
	Estimated       bool   `json:"estimated"` // estimated from the straight line, not planned by 高德
	// Polyline is the way ([[lng, lat], …], GCJ-02) when asked for: 高德's
	// route, simplified; the straight line when estimated.
	Polyline [][2]float64 `json:"polyline,omitempty"`
}

// DayLegs sums the legs of one day.
type DayLegs struct {
	Day       int  `json:"day"`
	Stops     int  `json:"stops"` // stops of the day, lodging not counted
	DistanceM int  `json:"distance_m"`
	DurationS int  `json:"duration_s"`
	Estimated bool `json:"estimated"` // some leg is estimated
	// The lodging the day starts from (the night before) and ends at.
	StartLodgingID *int64 `json:"start_lodging_id"`
	EndLodgingID   *int64 `json:"end_lodging_id"`
}

// TripLegsResult is the result of TripLegs.
type TripLegsResult struct {
	Mode string    `json:"mode"`
	Legs []Leg     `json:"legs"`
	Days []DayLegs `json:"days"`
	// Pending counts the estimated legs 高德 did not plan in time: asking
	// again a few seconds later (answers are cached) fills in more of them.
	Pending int `json:"pending"`
}

// LegsOptions tune TripLegs.
type LegsOptions struct {
	Mode string // one of LegModes; "" is auto
	// Transit: the trip prefers public transport, which is then the
	// recommended mode of long legs instead of driving.
	Transit  bool
	Geometry bool // fill Leg.Polyline
	// Network allows requests to 高德; without it only routes 高德 planned
	// recently (cached) replace the estimates.
	Network bool
}

const (
	legsWorkers = 3
	legMinAmapM = 50.0   // shorter legs are the same spot: not worth a request
	shortTransM = 1000.0 // public transport legs up to this far are walked

	// Recommended modes by straight-line distance (see RecommendMode).
	walkMaxM = 1200.0
	rideMaxM = 4000.0
)

// legsBudget is the time for all 高德 requests of one TripLegs call.
var legsBudget = 4 * time.Second

// legMaxAmapM is the longest straight-line leg planned by 高德 per mode;
// longer ones are estimated.
var legMaxAmapM = map[string]float64{"walking": 30000, "riding": 50000, "transit": 150000, "driving": 1000000}

// RecommendMode is the best way to cover a straight-line distance in
// metres: walking up to 1.2 km, riding (a shared bike) up to 4 km, farther
// driving, or public transport when the trip prefers it.
func RecommendMode(straight float64, transit bool) string {
	switch {
	case straight <= walkMaxM:
		return "walking"
	case straight <= rideMaxM:
		return "riding"
	case transit:
		return "transit"
	}
	return "driving"
}

// estimateLeg estimates a leg from its straight-line distance in metres:
// the way is 30 % (driving 40 %) longer; walking at 1.2 m/s; riding at
// 4 m/s plus 2 minutes to get and park a bike; public transport at 6 m/s
// plus 10 minutes of walking and waiting; driving at 8 m/s plus 3 minutes.
// Over 50 km (between cities: trains, coaches, highways) public transport
// and driving average 20 m/s.
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
	case mode == "riding":
		dist = 1.3 * straight
		dur = 120 + dist/4
	default:
		mode = "walking"
		dist = 1.3 * straight
		dur = dist / 1.2
	}
	return Leg{Mode: mode, DistanceM: int(math.Round(dist)), DurationS: int(math.Round(dur)),
		StraightM: int(math.Round(straight)), Estimated: true}
}

// EstimateTravel estimates travelling a straight-line distance in mode
// ("auto": the recommended mode): the way in metres and the time in seconds.
func EstimateTravel(mode string, straight float64, transit bool) (distM, durS int) {
	if mode == "" || mode == model.TravelAuto {
		mode = RecommendMode(straight, transit)
	}
	l := estimateLeg(mode, straight)
	return l.DistanceM, l.DurationS
}

// dayRoute is a day's route: the lodging of the night before (nil when
// none), its planned stops by seq and the lodging of the night. unrouted:
// the day is listed without legs (see dayRoutes).
type dayRoute struct {
	day        int
	start, end *model.Waypoint
	stops      []*model.Waypoint
	unrouted   bool
}

// points returns the day's route from start to end.
func (d *dayRoute) points() []*model.Waypoint {
	out := make([]*model.Waypoint, 0, len(d.stops)+2)
	if d.start != nil {
		out = append(out, d.start)
	}
	out = append(out, d.stops...)
	if d.end != nil {
		out = append(out, d.end)
	}
	return out
}

// dayRoutes splits the plan into days: day N goes from the lodging of night
// N-1 through its planned stops (by seq) to the lodging of night N. Days
// with neither stops nor lodging to go between are left out. Day 0 (未分天,
// the wishlist) has no lodging, comes last and is a route only while no day
// has planned stops (the plan is then the wishlist in order, as the route
// preview plays it); otherwise nobody draws it and its legs would only spend
// 高德 calls: it is listed unrouted.
func dayRoutes(wps []model.Waypoint) []dayRoute {
	stops := PlannedRoute(wps)
	lodging := Lodgings(wps)
	byDay := map[int][]*model.Waypoint{}
	maxDay := 0
	for i := range stops {
		w := &stops[i]
		byDay[w.Day] = append(byDay[w.Day], w)
		maxDay = max(maxDay, w.Day)
	}
	for n := range lodging {
		maxDay = max(maxDay, n+1)
	}
	var out []dayRoute
	scheduled := false // a day has planned stops
	for d := 1; d <= maxDay; d++ {
		r := dayRoute{day: d, start: lodging[d-1], end: lodging[d], stops: byDay[d]}
		scheduled = scheduled || len(r.stops) > 0
		if len(r.stops) == 0 && (r.start == nil || r.end == nil) {
			continue
		}
		out = append(out, r)
	}
	if pool := byDay[0]; len(pool) > 0 {
		out = append(out, dayRoute{day: 0, stops: pool, unrouted: scheduled})
	}
	return out
}

// TripLegs returns the legs of each day's planned route (see dayRoutes;
// none across days) and the totals of each day, day 0 (未分天) last. Legs
// are planned by 高德 when it is configured and answers in time, otherwise
// estimated (see estimateLeg).
func (s *Service) TripLegs(ctx context.Context, wps []model.Waypoint, opts LegsOptions) TripLegsResult {
	if opts.Mode == "" {
		opts.Mode = model.TravelAuto
	}
	res := TripLegsResult{Mode: opts.Mode, Legs: []Leg{}, Days: []DayLegs{}}
	var ends [][2]*model.Waypoint // the points of each leg
	for _, dr := range dayRoutes(wps) {
		day := DayLegs{Day: dr.day, Stops: len(dr.stops)}
		if dr.start != nil {
			day.StartLodgingID = &dr.start.ID
		}
		if dr.end != nil {
			day.EndLodgingID = &dr.end.ID
		}
		pts := dr.points()
		if dr.unrouted {
			pts = nil
		}
		for i := 1; i < len(pts); i++ {
			a, b := pts[i-1], pts[i]
			straight := geo.Haversine(a.Lng, a.Lat, b.Lng, b.Lat)
			if a.IsLodging() && b.IsLodging() && straight < legMinAmapM {
				continue // the same hotel on a day without stops
			}
			rec := RecommendMode(straight, opts.Transit)
			mode := opts.Mode
			if mode == model.TravelAuto {
				mode = rec
			}
			l := estimateLeg(mode, straight)
			l.FromID, l.ToID, l.Day, l.RecommendedMode = a.ID, b.ID, dr.day, rec
			if opts.Geometry {
				l.Polyline = straightLine(a, b)
			}
			res.Legs = append(res.Legs, l)
			ends = append(ends, [2]*model.Waypoint{a, b})
		}
		res.Days = append(res.Days, day)
	}
	res.Pending = s.planLegs(ctx, opts, res.Legs, ends)

	idx := map[int]int{}
	for i, d := range res.Days {
		idx[d.Day] = i
	}
	legCount := make([]int, len(res.Days))
	for _, l := range res.Legs {
		i := idx[l.Day]
		d := &res.Days[i]
		d.DistanceM += l.DistanceM
		d.DurationS += l.DurationS
		d.Estimated = d.Estimated || l.Estimated
		legCount[i]++
	}
	keep := res.Days[:0]
	for i, d := range res.Days {
		if d.Stops > 0 || legCount[i] > 0 { // not a day between two nights at the same hotel
			keep = append(keep, d)
		}
	}
	res.Days = keep
	return res
}

// straightLine is the polyline of an estimated leg.
func straightLine(a, b *model.Waypoint) [][2]float64 {
	return [][2]float64{{geo.Round(a.Lng, 5), geo.Round(a.Lat, 5)}, {geo.Round(b.Lng, 5), geo.Round(b.Lat, 5)}}
}

// planLegs replaces the estimates of legs by 高德 routes: cached ones, then
// (with opts.Network) from legsWorkers workers within legsBudget. Legs 高德
// does not answer in time keep their estimates; answers are cached, so
// later calls fill in more of them. It returns how many legs are pending
// (not planned for lack of time).
func (s *Service) planLegs(ctx context.Context, opts LegsOptions, legs []Leg, ends [][2]*model.Waypoint) int {
	if !s.Amap.Enabled() || len(legs) == 0 {
		return 0
	}
	// The budget cancels the context instead of letting it expire: a request
	// cut short by it says nothing about 高德's health, so it must not open
	// the client's circuit breaker as a timed-out request does.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	budget := time.AfterFunc(legsBudget, cancel)
	defer budget.Stop()
	var pending atomic.Int32
	apply := func(i int, r *amap.Route) {
		l := &legs[i]
		l.Mode, l.DistanceM, l.DurationS, l.Estimated = r.Mode, r.DistanceM, r.DurationS, false
		if opts.Geometry {
			if pl := r.Polyline(); len(pl) >= 2 {
				l.Polyline = pl
			}
		}
	}
	// legs[i].Mode is the requested mode, or walking for a short transit leg (see estimateLeg).
	var todo []int
	for i := range legs {
		if straight := float64(legs[i].StraightM); straight < legMinAmapM || straight > legMaxAmapM[legs[i].Mode] {
			continue
		}
		// Routes 高德 planned recently cost nothing: never held up by the budget.
		if r, _ := s.planLeg(ctx, legs[i].Mode, ends[i][0], ends[i][1], float64(legs[i].StraightM), false); r != nil {
			apply(i, r)
			continue
		}
		if opts.Network {
			todo = append(todo, i)
		}
	}
	jobs := make(chan int)
	var wg sync.WaitGroup
	for range min(legsWorkers, len(todo)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				r, wait := s.planLeg(ctx, legs[i].Mode, ends[i][0], ends[i][1], float64(legs[i].StraightM), true)
				if r != nil {
					apply(i, r)
				} else if wait {
					pending.Add(1)
				}
			}
		}()
	}
	for _, i := range todo {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	return int(pending.Load())
}

// planLeg asks 高德 for the route of one leg (only its cache unless
// network); nil keeps the estimate, and wait reports that 高德 was not
// asked or did not answer for lack of time (a later call may succeed).
// Public transport needs the cities of both points; short legs, and legs
// without public transport, are walked.
func (s *Service) planLeg(ctx context.Context, mode string, a, b *model.Waypoint, straight float64, network bool) (r *amap.Route, wait bool) {
	direction := func(m, city, cityd string) (*amap.Route, error) {
		if r, ok := s.Amap.CachedDirection(m, a.Lng, a.Lat, b.Lng, b.Lat, city, cityd); ok {
			return r, nil
		}
		if !network {
			return nil, errNotAsked
		}
		return s.Amap.Direction(ctx, m, a.Lng, a.Lat, b.Lng, b.Lat, city, cityd)
	}
	waiting := func(err error) bool {
		return network && (ctx.Err() != nil || errors.Is(err, amap.ErrBusy))
	}
	if mode == "transit" && straight > shortTransM {
		city, cityd := s.legCity(a), s.legCity(b)
		if city == "" || cityd == "" {
			return nil, false
		}
		r, err := direction(mode, city, cityd)
		if err == nil {
			return r, false
		}
		if !errors.Is(err, amap.ErrNoRoute) {
			return nil, waiting(err)
		}
	}
	if mode == "transit" {
		mode = "walking"
		if straight > legMaxAmapM[mode] {
			return nil, false
		}
	}
	r, err := direction(mode, "", "")
	if err != nil {
		return nil, waiting(err)
	}
	return r, false
}

// errNotAsked: a cache-only lookup found nothing.
var errNotAsked = errors.New("not asked")

// legCity is the city of a stop for 高德's public transport planning.
func (s *Service) legCity(w *model.Waypoint) string {
	if w.City != "" {
		return w.City
	}
	if s.Atlas != nil {
		if loc, ok := s.Atlas.LookupGCJ(w.Lng, w.Lat); ok {
			return loc.City
		}
	}
	return ""
}
