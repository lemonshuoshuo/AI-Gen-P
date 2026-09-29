package service

import (
	"fmt"
	"math"
	"slices"
	"sort"

	"triphub/internal/geo"
	"triphub/internal/model"
)

// InputError is a request the service cannot carry out, with a message for
// the user (handlers answer 400 with it).
type InputError struct{ Msg string }

func (e *InputError) Error() string { return e.Msg }

func inputErr(format string, a ...any) error { return &InputError{Msg: fmt.Sprintf(format, a...)} }

// ArrangeStop is a stop to place in an arrangement.
type ArrangeStop struct {
	ID       int64
	Lng, Lat float64
	// Fixed stops stay on Day (1..Days); the others are assigned a day.
	Fixed bool
	Day   int
	// Keep (for fixed stops): the stop's place in its day's order is kept;
	// the other stops of the day are inserted between the kept ones where
	// they add the least way.
	Keep bool
	// Order is the stop's current place in the trip (seq): kept stops
	// keep it, and it breaks ties so the result does not depend on the
	// order of Stops.
	Order int
}

// ArrangeInput is the problem Arrange solves: Days days, day d starting at
// Start[d] and ending at End[d] (the lodging of the nights before and
// after it; nil when none), and the stops to place.
type ArrangeInput struct {
	Days  int
	Start map[int]*geo.Point
	End   map[int]*geo.Point
	Stops []ArrangeStop
}

// arrangeIters bounds the rounds of the balanced clustering.
const arrangeIters = 30

// sameLodgingM: days whose lodging is this close share it (one hotel for
// several nights) and are interchangeable for the clustering.
const sameLodgingM = 3000.0

// Arrange distributes stops over days 1..in.Days and orders each day to
// keep its way short. It returns, for each day (index d-1), the IDs of its
// stops in order.
//
// Days are clusters. A day with stops fixed to it is centred on them (and
// its lodging); a day with its own lodging is centred on the lodging; days
// sharing a lodging (one hotel for several nights), and days without
// anchors, are seeded by farthest-point sampling (a deterministic
// k-means++) over the free stops near that lodging, or over all free stops.
// Stops are assigned greedily by distance to the day centres, each day
// taking at most ceil(n/Days) stops (more only when that many are fixed to
// it), and the centres are recomputed until the assignment settles.
// Interchangeable days (without anchors, or sharing a lodging) then take
// their clusters in a chain: each the cluster nearest the previous day's,
// the first day the cluster with the trip's first stop. Each day is ordered
// from its start lodging (else where the previous day ended) to its end
// lodging by nearest neighbour and 2-opt, or, when it has kept stops, by
// inserting its other stops where they add the least way. Distances are
// great-circle metres; the result is deterministic.
func Arrange(in ArrangeInput) [][]int64 {
	D := in.Days
	out := make([][]int64, max(D, 0))
	if D <= 0 {
		return out
	}
	stops := slices.Clone(in.Stops)
	for i := range stops {
		if stops[i].Fixed && (stops[i].Day < 1 || stops[i].Day > D) {
			stops[i].Fixed, stops[i].Keep = false, false // no such day: placed like the others
		}
	}
	sort.SliceStable(stops, func(i, j int) bool {
		if stops[i].Order != stops[j].Order {
			return stops[i].Order < stops[j].Order
		}
		return stops[i].ID < stops[j].ID
	})
	n := len(stops)
	pt := func(i int) geo.Point { return geo.Point{Lng: stops[i].Lng, Lat: stops[i].Lat} }
	dist := func(a, b geo.Point) float64 { return geo.Haversine(a.Lng, a.Lat, b.Lng, b.Lat) }

	// Anchors of each day: fixed stops and lodging.
	fixedN := make([]int, D)
	for _, s := range stops {
		if s.Fixed {
			fixedN[s.Day-1]++
		}
	}
	lodging := make([]*geo.Point, D) // the centre of the day's lodging
	for d := range D {
		var ps []geo.Point
		for _, p := range []*geo.Point{in.Start[d+1], in.End[d+1]} {
			if p != nil {
				ps = append(ps, *p)
			}
		}
		if len(ps) > 0 {
			c := centroid(ps)
			lodging[d] = &c
		}
	}
	// Interchangeable days: without fixed stops, by lodging (none, or
	// within sameLodgingM of the group's first day's).
	group := make([]int, D) // group id; days with fixed stops are alone
	size := map[int]int{}
	for d := range D {
		group[d] = d
		if fixedN[d] == 0 {
			for e := 0; e < d; e++ {
				if fixedN[e] != 0 || group[e] != e {
					continue
				}
				if (lodging[d] == nil && lodging[e] == nil) ||
					(lodging[d] != nil && lodging[e] != nil && dist(*lodging[d], *lodging[e]) <= sameLodgingM) {
					group[d] = e
					break
				}
			}
		}
		size[group[d]]++
	}
	lodgingWeight := func(d int) float64 { return 2 / float64(size[group[d]]) }
	centreOf := func(d int, assigned func(i int) bool) (geo.Point, bool) {
		var c geo.Point
		w := 0.0
		add := func(p geo.Point, weight float64) {
			c.Lng += p.Lng * weight
			c.Lat += p.Lat * weight
			w += weight
		}
		if lodging[d] != nil {
			add(*lodging[d], lodgingWeight(d))
		}
		for i := range stops {
			if (stops[i].Fixed && stops[i].Day == d+1) || assigned(i) {
				add(pt(i), 1)
			}
		}
		if w == 0 {
			return c, false
		}
		return geo.Point{Lng: c.Lng / w, Lat: c.Lat / w}, true
	}
	none := func(int) bool { return false }

	var free []int // movable stops
	for i, s := range stops {
		if !s.Fixed {
			free = append(free, i)
		}
	}
	// Seeds: fixed and single-lodging days first, then farthest-point
	// sampling for shared-lodging days (among the free stops nearest their
	// lodging) and days without anchors (among all free stops).
	centres := make([]geo.Point, D)
	seeded := make([]bool, D)
	var seeds []geo.Point
	for d := range D {
		if fixedN[d] > 0 || (lodging[d] != nil && size[group[d]] == 1) {
			centres[d], seeded[d] = centreOf(d, none)
			seeds = append(seeds, centres[d])
		}
	}
	var lodgingGroups []int
	for d := range D {
		if lodging[d] != nil && group[d] == d {
			lodgingGroups = append(lodgingGroups, d)
		}
	}
	farthest := func(pool []int, from []geo.Point) int {
		best, bestD := -1, -1.0
		for _, i := range pool {
			nearest := math.Inf(1)
			for _, s := range from {
				nearest = min(nearest, dist(s, pt(i)))
			}
			if len(from) == 0 {
				nearest = 0
			}
			if nearest > bestD {
				best, bestD = i, nearest
			}
		}
		return best
	}
	for d := range D {
		if seeded[d] {
			continue
		}
		pool := free
		from := seeds
		if lodging[d] != nil { // a shared lodging: the free stops nearest to it
			pool = nil
			for _, i := range free {
				bg, bd := -1, math.Inf(1)
				for _, g := range lodgingGroups {
					if dd := dist(*lodging[g], pt(i)); dd < bd {
						bg, bd = g, dd
					}
				}
				if bg == group[d] {
					pool = append(pool, i)
				}
			}
			from = append(slices.Clone(seeds), *lodging[group[d]])
		}
		if len(from) == 0 && len(pool) > 0 { // nothing to start from: the farthest from their centre
			ps := make([]geo.Point, len(pool))
			for k, i := range pool {
				ps[k] = pt(i)
			}
			from = []geo.Point{centroid(ps)}
		}
		switch i := farthest(pool, from); {
		case i >= 0:
			centres[d] = pt(i)
		case lodging[d] != nil:
			centres[d] = *lodging[d]
		case len(seeds) > 0:
			centres[d] = seeds[len(seeds)-1]
		}
		seeded[d] = true
		seeds = append(seeds, centres[d])
	}

	// Balanced assignment.
	per := (n + D - 1) / D
	capacity := make([]int, D)
	for d := range capacity {
		capacity[d] = max(per, fixedN[d])
	}
	day := make([]int, n) // 0-based day of each stop
	for i, s := range stops {
		day[i] = -1
		if s.Fixed {
			day[i] = s.Day - 1
		}
	}
	type pair struct {
		stop, day int
		dist      float64
	}
	pairs := make([]pair, 0, len(free)*D)
	for iter := 0; iter < arrangeIters && len(free) > 0; iter++ {
		pairs = pairs[:0]
		for _, i := range free {
			for d := range D {
				pairs = append(pairs, pair{i, d, dist(centres[d], pt(i))})
			}
		}
		sort.SliceStable(pairs, func(a, b int) bool {
			if pairs[a].dist != pairs[b].dist {
				return pairs[a].dist < pairs[b].dist
			}
			if pairs[a].stop != pairs[b].stop {
				return pairs[a].stop < pairs[b].stop
			}
			return pairs[a].day < pairs[b].day
		})
		load := slices.Clone(fixedN)
		next := slices.Clone(day)
		for _, i := range free {
			next[i] = -1
		}
		for _, p := range pairs {
			if next[p.stop] < 0 && load[p.day] < capacity[p.day] {
				next[p.stop] = p.day
				load[p.day]++
			}
		}
		changed := !slices.Equal(next, day)
		day = next
		for d := range D {
			if c, ok := centreOf(d, func(i int) bool { return !stops[i].Fixed && day[i] == d }); ok {
				centres[d] = c
			}
		}
		if !changed {
			break
		}
	}

	// Interchangeable days take their group's clusters in a chain.
	clusterDay := map[int]int{} // cluster (the day it was built as) → day
	left := map[int][]int{}     // group → clusters not yet taken
	for d := range D {
		left[group[d]] = append(left[group[d]], d)
	}
	for d := range D {
		cands := left[group[d]]
		best, bestScore := cands[0], math.Inf(1)
		if len(cands) > 1 {
			for _, c := range cands {
				score := math.Inf(1)
				if d == 0 { // the cluster with the trip's first stop
					for i := range stops {
						if day[i] == c {
							score = float64(i)
							break
						}
					}
				} else {
					score = dist(centres[clusterOfDay(clusterDay, d-1)], centres[c])
				}
				if score < bestScore {
					best, bestScore = c, score
				}
			}
		}
		clusterDay[best] = d
		left[group[d]] = slices.DeleteFunc(cands, func(c int) bool { return c == best })
	}
	for i := range day {
		if !stops[i].Fixed && day[i] >= 0 {
			day[i] = clusterDay[day[i]]
		}
	}

	// Order each day.
	var prevEnd *geo.Point
	for d := range D {
		var idx []int
		for i := range stops {
			if day[i] == d {
				idx = append(idx, i)
			}
		}
		start, end := in.Start[d+1], in.End[d+1]
		lead := start
		if lead == nil {
			lead = prevEnd // continue from where the previous day ended
		}
		order := orderDay(stops, idx, lead, end)
		for _, i := range order {
			out[d] = append(out[d], stops[i].ID)
		}
		switch {
		case end != nil:
			prevEnd = end
		case len(order) > 0:
			p := pt(order[len(order)-1])
			prevEnd = &p
		default:
			prevEnd = lead
		}
	}
	return out
}

// clusterOfDay returns the cluster taken by day d (see Arrange).
func clusterOfDay(clusterDay map[int]int, d int) int {
	for c, cd := range clusterDay {
		if cd == d {
			return c
		}
	}
	return d
}

func centroid(ps []geo.Point) geo.Point {
	var c geo.Point
	for _, p := range ps {
		c.Lng += p.Lng / float64(len(ps))
		c.Lat += p.Lat / float64(len(ps))
	}
	return c
}

// orderDay orders the stops idx of one day from start (nil: free) to end
// (nil: free). Kept stops keep their order and the others are inserted
// where they add the least way; without kept stops the order is built by
// nearest neighbour (from each possible first stop when there is no start,
// up to 12 stops) and improved by 2-opt.
func orderDay(stops []ArrangeStop, idx []int, start, end *geo.Point) []int {
	if len(idx) == 0 {
		return nil
	}
	p := func(i int) *geo.Point { return &geo.Point{Lng: stops[i].Lng, Lat: stops[i].Lat} }
	edge := func(a, b *geo.Point) float64 {
		if a == nil || b == nil {
			return 0
		}
		return geo.Haversine(a.Lng, a.Lat, b.Lng, b.Lat)
	}
	at := func(seq []int, k int) *geo.Point { // the point at k, start / end beyond the ends
		switch {
		case k < 0:
			return start
		case k >= len(seq):
			return end
		}
		return p(seq[k])
	}
	cost := func(seq []int) float64 {
		c := 0.0
		for k := 0; k <= len(seq); k++ {
			c += edge(at(seq, k-1), at(seq, k))
		}
		return c
	}
	var kept, loose []int
	for _, i := range idx {
		if stops[i].Keep {
			kept = append(kept, i)
		} else {
			loose = append(loose, i)
		}
	}
	if len(kept) > 0 {
		seq := kept // idx is in Order, so the kept stops are too
		for len(loose) > 0 {
			bi, bpos, bd := 0, 0, math.Inf(1)
			for li, i := range loose {
				for pos := 0; pos <= len(seq); pos++ {
					a, b := at(seq, pos-1), at(seq, pos)
					if d := edge(a, p(i)) + edge(p(i), b) - edge(a, b); d < bd-1e-9 {
						bi, bpos, bd = li, pos, d
					}
				}
			}
			seq = slices.Insert(seq, bpos, loose[bi])
			loose = slices.Delete(loose, bi, bi+1)
		}
		return seq
	}
	twoOpt := func(seq []int) []int {
		for improved := true; improved; {
			improved = false
			for i := 0; i < len(seq); i++ {
				for j := i + 1; j < len(seq); j++ {
					a, b := at(seq, i-1), at(seq, j+1)
					delta := edge(a, p(seq[j])) + edge(p(seq[i]), b) - edge(a, p(seq[i])) - edge(p(seq[j]), b)
					if delta < -1e-6 {
						slices.Reverse(seq[i : j+1])
						improved = true
					}
				}
			}
		}
		return seq
	}
	nearest := func(first int) []int {
		var seq []int
		rest := slices.Clone(idx)
		cur := start
		if first >= 0 {
			seq = append(seq, first)
			rest = slices.DeleteFunc(rest, func(i int) bool { return i == first })
			cur = p(first)
		}
		for len(rest) > 0 {
			bk, bd := 0, math.Inf(1)
			for k, i := range rest {
				if d := edge(cur, p(i)); cur != nil && d < bd {
					bk, bd = k, d
				}
			}
			seq = append(seq, rest[bk])
			cur = p(rest[bk])
			rest = slices.Delete(rest, bk, bk+1)
		}
		return twoOpt(seq)
	}
	if start != nil {
		return nearest(-1)
	}
	firsts := idx
	if len(idx) > 12 { // the stop farthest from the others' centre starts
		ps := make([]geo.Point, len(idx))
		for k, i := range idx {
			ps[k] = *p(i)
		}
		c := centroid(ps)
		first, bd := idx[0], -1.0
		for _, i := range idx {
			if d := edge(&c, p(i)); d > bd {
				first, bd = i, d
			}
		}
		firsts = []int{first}
	}
	var best []int
	bestC := math.Inf(1)
	for _, first := range firsts {
		seq := nearest(first)
		if c := cost(seq); c < bestC-1e-9 {
			best, bestC = seq, c
		}
	}
	return best
}

// Arrangement scopes.
const (
	ArrangePool = "pool" // place the 未分天 stops, keeping the days already planned
	ArrangeAll  = "all"  // re-plan every stop not yet visited
)

// ArrangeRequest asks PlanArrangement for an arrangement.
type ArrangeRequest struct {
	Scope string
	Mode  string // a travel mode for the day totals; "auto" or "" the recommended ones
	Days  int    // days to arrange over (0: the trip's)
	// Fixed pins stops to days.
	Fixed map[int64]int
}

// ArrangeItem is a waypoint's place in an arrangement.
type ArrangeItem struct {
	ID  int64 `json:"id"`
	Day int   `json:"day"`
	Seq int   `json:"seq"`
}

// ArrangeDay sums up one day of an arrangement (estimated: straight-line
// legs in the recommended or requested mode, see EstimateTravel).
type ArrangeDay struct {
	Day            int     `json:"day"`
	IDs            []int64 `json:"ids"` // the day's stops in order
	Stops          int     `json:"stops"`
	DistanceM      int     `json:"distance_m"`
	DurationS      int     `json:"duration_s"`
	StartLodgingID *int64  `json:"start_lodging_id"`
	EndLodgingID   *int64  `json:"end_lodging_id"`
}

// Arrangement is the result of PlanArrangement: every waypoint of the trip
// with its new day and seq (Items, in seq order), and the days.
type Arrangement struct {
	Scope   string        `json:"scope"`
	Mode    string        `json:"mode"`
	Days    int           `json:"days"`
	Items   []ArrangeItem `json:"items"`
	DayList []ArrangeDay  `json:"day_totals"`
	// Changed counts the waypoints whose day or seq changes.
	Changed int `json:"changed"`
}

// PlanArrangement arranges a trip's stops (wps: all its waypoints) over
// days (see Arrange). Scope ArrangePool places the planned stops of day 0
// (未分天) and keeps the planned stops already on days 1..Days where they
// are; ArrangeAll re-plans every planned stop not yet visited or skipped.
// Stops in req.Fixed stay on the given day. Visited, skipped and unplanned
// stops, and stops on days after Days, are not moved: in the new seq order
// they come first on their day. Each day starts at the lodging of the
// night before and ends at the night's lodging. transit: the trip prefers
// public transport (for the totals in auto mode).
func PlanArrangement(wps []model.Waypoint, req ArrangeRequest, tripDays int, transit bool) (*Arrangement, error) {
	D := req.Days
	if D == 0 {
		D = tripDays
	}
	all := slices.Clone(wps)
	sortBySeq(all)
	byID := map[int64]*model.Waypoint{}
	for i := range all {
		byID[all[i].ID] = &all[i]
	}
	for id, d := range req.Fixed {
		w := byID[id]
		if w == nil || w.IsLodging() || !w.Planned {
			return nil, inputErr("fixed 中的打卡点 %d 不是该旅程的计划点", id)
		}
		if d < 1 || (D > 0 && d > D) {
			return nil, inputErr("fixed 中的天数 %d 超出范围", d)
		}
		D = max(D, d)
	}
	if D == 0 {
		// No days planned yet: about 5 stops a day.
		n := 0
		for i := range all {
			if w := &all[i]; w.Planned && !w.IsLodging() && w.Status == model.WPTodo && (w.Day == 0 || req.Scope == ArrangeAll) {
				n++
			}
		}
		D = max(1, (n+4)/5)
	}
	if D > 60 {
		return nil, inputErr("最多安排 60 天")
	}
	in := ArrangeInput{Days: D, Start: map[int]*geo.Point{}, End: map[int]*geo.Point{}}
	lodging := Lodgings(all)
	for n, w := range lodging {
		p := &geo.Point{Lng: w.Lng, Lat: w.Lat}
		if n+1 <= D {
			in.Start[n+1] = p
		}
		if n >= 1 && n <= D {
			in.End[n] = p
		}
	}
	for i := range all {
		w := &all[i]
		if !w.Planned || w.IsLodging() || w.Status != model.WPTodo {
			continue
		}
		s := ArrangeStop{ID: w.ID, Lng: w.Lng, Lat: w.Lat, Order: w.Seq}
		fd, pinned := req.Fixed[w.ID]
		switch {
		case pinned:
			s.Fixed, s.Day = true, fd
		case req.Scope == ArrangePool && w.Day >= 1 && w.Day <= D:
			s.Fixed, s.Day, s.Keep = true, w.Day, true
		case req.Scope == ArrangePool && w.Day != 0:
			continue // after the days arranged
		}
		in.Stops = append(in.Stops, s)
	}
	days := Arrange(in)

	// The new order: per night / day, lodging and stops.
	newDay := map[int64]int{}
	for d, ids := range days {
		for _, id := range ids {
			newDay[id] = d + 1
		}
	}
	placed := map[int64]bool{}
	var order []*model.Waypoint
	put := func(w *model.Waypoint) {
		if w != nil && !placed[w.ID] {
			placed[w.ID] = true
			order = append(order, w)
		}
	}
	maxDay := D
	for i := range all {
		maxDay = max(maxDay, all[i].Day)
	}
	put(lodging[0])
	for d := 1; d <= maxDay; d++ {
		for i := range all {
			w := &all[i]
			if _, moved := newDay[w.ID]; !moved && !w.IsLodging() && w.Day == d {
				put(w)
			}
		}
		if d <= D {
			for _, id := range days[d-1] {
				put(byID[id])
			}
		}
		put(lodging[d])
	}
	for i := range all { // 未分天 and anything left (a second lodging of a night)
		if w := &all[i]; !placed[w.ID] {
			if _, moved := newDay[w.ID]; !moved {
				put(w)
			}
		}
	}
	res := &Arrangement{Scope: req.Scope, Mode: req.Mode, Days: D, Items: make([]ArrangeItem, 0, len(order)), DayList: []ArrangeDay{}}
	for seq, w := range order {
		d := w.Day
		if nd, ok := newDay[w.ID]; ok {
			d = nd
		}
		if d != w.Day || seq != w.Seq {
			res.Changed++
		}
		res.Items = append(res.Items, ArrangeItem{ID: w.ID, Day: d, Seq: seq})
	}
	for d := 1; d <= D; d++ {
		ad := ArrangeDay{Day: d, IDs: days[d-1], Stops: len(days[d-1])}
		if ad.IDs == nil {
			ad.IDs = []int64{}
		}
		var pts []geo.Point
		if l := lodging[d-1]; l != nil {
			ad.StartLodgingID = &l.ID
			pts = append(pts, geo.Point{Lng: l.Lng, Lat: l.Lat})
		}
		for _, id := range ad.IDs {
			pts = append(pts, geo.Point{Lng: byID[id].Lng, Lat: byID[id].Lat})
		}
		if l := lodging[d]; l != nil {
			ad.EndLodgingID = &l.ID
			pts = append(pts, geo.Point{Lng: l.Lng, Lat: l.Lat})
		}
		for i := 1; i < len(pts); i++ {
			m, s := EstimateTravel(req.Mode, geo.Haversine(pts[i-1].Lng, pts[i-1].Lat, pts[i].Lng, pts[i].Lat), transit)
			ad.DistanceM += m
			ad.DurationS += s
		}
		res.DayList = append(res.DayList, ad)
	}
	return res, nil
}
