package service

import (
	"context"
	"fmt"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"triphub/internal/amap"
	"triphub/internal/geo"
	"triphub/internal/model"
)

func names(ws []model.Waypoint) string {
	var out []string
	for _, w := range ws {
		out = append(out, w.Name)
	}
	return strings.Join(out, ",")
}

// lodgingTrip: two days in 杭州 with a hotel for night 0 (the evening
// before), night 1 (another hotel) and night 2; lodging rows stored at odd
// places in seq, one pool stop and an unplanned stop.
func lodgingTrip() []model.Waypoint {
	h := func(id int64, seq, night int, name string, lng, lat float64) model.Waypoint {
		return model.Waypoint{ID: id, Seq: seq, Day: night, Kind: model.KindLodging, Planned: true, Status: model.WPTodo,
			Name: name, City: "杭州市", Lng: lng, Lat: lat}
	}
	st := func(id int64, seq, day int, name string, lng, lat float64) model.Waypoint {
		return model.Waypoint{ID: id, Seq: seq, Day: day, Kind: model.KindStop, Planned: true, Status: model.WPTodo,
			Name: name, City: "杭州市", Lng: lng, Lat: lat}
	}
	return []model.Waypoint{
		h(20, 0, 2, "H2", 120.17, 30.25), // stored first
		st(1, 1, 1, "A", 120.1513, 30.2610),
		st(2, 2, 1, "B", 120.1437, 30.2556),
		h(10, 3, 0, "H0", 120.1600, 30.2700),
		st(3, 4, 2, "C", 120.1488, 30.2317),
		st(4, 5, 2, "D", 120.1016, 30.2408),
		{ID: 9, Seq: 6, Day: 2, Kind: model.KindStop, Planned: false, Status: model.WPVisited, Name: "X", Lng: 120.12, Lat: 30.24},
		st(5, 7, 0, "P", 120.2, 30.3),
		h(11, 8, 1, "H1", 120.1400, 30.2500),
	}
}

func TestPlanOrder(t *testing.T) {
	if got := names(PlanOrder(lodgingTrip())); got != "H0,A,B,H1,C,D,H2,P" {
		t.Fatalf("plan order %s", got)
	}
	// A night without stops that day: after the latest earlier day's stops.
	wps := []model.Waypoint{
		{ID: 1, Seq: 0, Day: 1, Planned: true, Name: "A"},
		{ID: 2, Seq: 1, Day: 3, Planned: true, Name: "C"},
		{ID: 3, Seq: 2, Day: 2, Kind: model.KindLodging, Planned: true, Name: "H2"},
		{ID: 4, Seq: 3, Day: 5, Kind: model.KindLodging, Planned: true, Name: "H5"},
	}
	if got := names(PlanOrder(wps)); got != "A,H2,C,H5" {
		t.Fatalf("plan order %s", got)
	}
	if n := CountStops(lodgingTrip()); n != 6 {
		t.Fatalf("stops %d", n)
	}
	if got := names(PlannedRoute(lodgingTrip())); got != "A,B,C,D,P" {
		t.Fatalf("planned route %s", got)
	}
}

func TestPendingPlanLodging(t *testing.T) {
	wps := lodgingTrip()
	set := func(name, status string) {
		for i := range wps {
			if wps[i].Name == name {
				wps[i].Status = status
			}
		}
	}
	// Day 1 done: tonight's hotel is next.
	set("A", model.WPVisited)
	set("B", model.WPVisited)
	if todo, ahead := PendingPlanAt(wps, 1); names(todo) != "H1,C,D,H2,P" || ahead != 5 {
		t.Fatalf("end of day 1: %s (%d)", names(todo), ahead)
	}
	// The next morning without checking in at H1: its night is over.
	if todo, _ := PendingPlanAt(wps, 2); names(todo) != "C,D,H2,P" {
		t.Fatalf("morning of day 2: %s", names(todo))
	}
	// Past the hotel (a day 2 stop visited): H1 is not pending, H0 neither.
	set("C", model.WPVisited)
	if todo, ahead := PendingPlan(wps); names(todo) != "D,H2,P" || ahead != 3 {
		t.Fatalf("day 2: %s (%d)", names(todo), ahead)
	}
}

func TestTripLegsLodging(t *testing.T) {
	s := &Service{Amap: amap.New("")}
	res := s.TripLegs(context.Background(), lodgingTrip(), LegsOptions{Mode: "auto", Geometry: true})
	var pairs []string
	for _, l := range res.Legs {
		pairs = append(pairs, fmt.Sprintf("%d-%d@%d", l.FromID, l.ToID, l.Day))
		if l.Mode != l.RecommendedMode || l.Mode != RecommendMode(float64(l.StraightM), false) || len(l.Polyline) != 2 {
			t.Errorf("leg %+v", l)
		}
	}
	// Day 1: H0 → A → B → H1; day 2: H1 → C → D → H2; the pool: no legs (one stop).
	if got := strings.Join(pairs, ","); got != "10-1@1,1-2@1,2-11@1,11-3@2,3-4@2,4-20@2" {
		t.Fatalf("legs %s", got)
	}
	id := func(p *int64) int64 {
		if p == nil {
			return 0
		}
		return *p
	}
	if len(res.Days) != 3 || res.Days[0].Stops != 2 || id(res.Days[0].StartLodgingID) != 10 || id(res.Days[0].EndLodgingID) != 11 ||
		id(res.Days[1].StartLodgingID) != 11 || id(res.Days[1].EndLodgingID) != 20 || res.Days[2].Day != 0 || res.Days[2].StartLodgingID != nil {
		t.Fatalf("days %+v", res.Days)
	}
	// A day without stops between two hotels: the move; between the same hotel twice: nothing.
	wps := []model.Waypoint{
		{ID: 1, Day: 1, Kind: model.KindLodging, Planned: true, Lng: 120.1, Lat: 30.2},
		{ID: 2, Day: 2, Kind: model.KindLodging, Planned: true, Lng: 120.5, Lat: 30.2},
		{ID: 3, Day: 3, Kind: model.KindLodging, Planned: true, Lng: 120.5, Lat: 30.2},
	}
	res = s.TripLegs(context.Background(), wps, LegsOptions{Transit: true})
	if len(res.Legs) != 1 || res.Legs[0].FromID != 1 || res.Legs[0].ToID != 2 || res.Legs[0].Mode != "transit" || res.Mode != "auto" ||
		len(res.Days) != 1 || res.Days[0].Day != 2 || res.Days[0].Stops != 0 {
		t.Fatalf("hotel change: %+v", res)
	}
}

func TestRecommendMode(t *testing.T) {
	for _, c := range []struct {
		m       float64
		transit bool
		want    string
	}{{800, false, "walking"}, {1200, true, "walking"}, {1500, false, "riding"}, {4000, true, "riding"},
		{4500, false, "driving"}, {4500, true, "transit"}, {80000, false, "driving"}} {
		if got := RecommendMode(c.m, c.transit); got != c.want {
			t.Errorf("RecommendMode(%v, %v) = %s", c.m, c.transit, got)
		}
	}
	if l := estimateLeg("riding", 3000); l.Mode != "riding" || l.DistanceM != 3900 || l.DurationS != 120+975 {
		t.Errorf("riding estimate %+v", l)
	}
}

// Legs planned by 高德 keep its way; later calls without network use the
// routes cached.
func TestTripLegsGeometry(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		q := r.URL.Query()
		var from, to [2]float64
		fmt.Sscanf(strings.Replace(q.Get("origin"), ",", " ", 1), "%f %f", &from[0], &from[1])
		fmt.Sscanf(strings.Replace(q.Get("destination"), ",", " ", 1), "%f %f", &to[0], &to[1])
		mid := fmt.Sprintf("%.6f,%.6f", (from[0]+to[0])/2+0.003, (from[1]+to[1])/2)
		poly := fmt.Sprintf("%.6f,%.6f;%s;%.6f,%.6f", from[0], from[1], mid, to[0], to[1])
		switch r.URL.Path {
		case "/v4/direction/bicycling":
			_, _ = fmt.Fprintf(w, `{"errcode":0,"errmsg":"OK","data":{"paths":[{"distance":2000,"duration":600,"steps":[{"polyline":"%s"}]}]}}`, poly)
		default:
			_, _ = fmt.Fprintf(w, `{"status":"1","route":{"paths":[{"distance":"1500","duration":"900","steps":[{"polyline":"%s"}]}]}}`, poly)
		}
	}))
	defer srv.Close()
	c := amap.New("k")
	c.SetBaseURL(srv.URL)
	s := &Service{Amap: c}
	opts := LegsOptions{Mode: "auto", Geometry: true, Network: true}
	res := s.TripLegs(context.Background(), lodgingTrip(), opts)
	for _, l := range res.Legs {
		if l.StraightM < 50 {
			continue
		}
		if l.Estimated || len(l.Polyline) != 3 {
			t.Fatalf("leg %+v", l)
		}
	}
	n := calls.Load()
	opts.Network = false
	again := s.TripLegs(context.Background(), lodgingTrip(), opts)
	if calls.Load() != n || !reflect.DeepEqual(again, res) {
		t.Fatalf("cached legs differ or asked 高德 again (%d → %d requests)", n, calls.Load())
	}
	opts.Geometry = false
	for _, l := range s.TripLegs(context.Background(), lodgingTrip(), opts).Legs {
		if l.Polyline != nil {
			t.Fatalf("polyline without geometry: %+v", l)
		}
	}
}

// ---- arrangement ----

// cluster returns n stops around (lng, lat), ~300 m apart, with IDs from id.
func cluster(id int64, order, n int, lng, lat float64) []ArrangeStop {
	var out []ArrangeStop
	for i := range n {
		out = append(out, ArrangeStop{ID: id + int64(i), Order: order + i,
			Lng: lng + 0.003*float64(i%3), Lat: lat + 0.003*float64(i/3)})
	}
	return out
}

func dayOfIDs(days [][]int64) map[int64]int {
	m := map[int64]int{}
	for d, ids := range days {
		for _, id := range ids {
			m[id] = d + 1
		}
	}
	return m
}

func pathLen(in ArrangeInput, day int, ids []int64) float64 {
	pos := map[int64]geo.Point{}
	for _, s := range in.Stops {
		pos[s.ID] = geo.Point{Lng: s.Lng, Lat: s.Lat}
	}
	var pts []geo.Point
	if p := in.Start[day]; p != nil {
		pts = append(pts, *p)
	}
	for _, id := range ids {
		pts = append(pts, pos[id])
	}
	if p := in.End[day]; p != nil {
		pts = append(pts, *p)
	}
	return geo.PathLength(pts)
}

func TestArrangeClusters(t *testing.T) {
	// 西湖 and 西溪 (about 8 km apart), interleaved in the trip's order.
	a := cluster(100, 0, 4, 120.15, 30.25)
	b := cluster(200, 0, 4, 120.07, 30.27)
	var stops []ArrangeStop
	for i := range 4 {
		b[i].Order = 2*i + 1
		a[i].Order = 2 * i
		stops = append(stops, b[i], a[i])
	}
	in := ArrangeInput{Days: 2, Stops: stops}
	days := Arrange(in)
	m := dayOfIDs(days)
	for _, s := range a {
		if m[s.ID] != 1 { // the trip's first stop is in 西湖: day 1
			t.Fatalf("西湖 stop %d on day %d: %v", s.ID, m[s.ID], days)
		}
	}
	for _, s := range b {
		if m[s.ID] != 2 {
			t.Fatalf("西溪 stop %d on day %d: %v", s.ID, m[s.ID], days)
		}
	}
	// Deterministic, whatever the order of the input.
	for seed := int64(1); seed <= 5; seed++ {
		shuffled := slices.Clone(stops)
		rand.New(rand.NewSource(seed)).Shuffle(len(shuffled), func(i, j int) { shuffled[i], shuffled[j] = shuffled[j], shuffled[i] })
		if got := Arrange(ArrangeInput{Days: 2, Stops: shuffled}); !reflect.DeepEqual(got, days) {
			t.Fatalf("seed %d: %v, want %v", seed, got, days)
		}
	}
}

func TestArrangeLodgingAnchors(t *testing.T) {
	// Day 1 ends at a hotel near 西溪, day 2 goes from it to a hotel near 西湖:
	// day 1 is 西溪, day 2 西湖, though the trip lists 西湖 first.
	a := cluster(100, 0, 3, 120.15, 30.25)
	b := cluster(200, 3, 3, 120.07, 30.27)
	hotelB := &geo.Point{Lng: 120.075, Lat: 30.275}
	hotelA := &geo.Point{Lng: 120.16, Lat: 30.26}
	in := ArrangeInput{Days: 2, Stops: append(a, b...),
		Start: map[int]*geo.Point{2: hotelB}, End: map[int]*geo.Point{1: hotelB, 2: hotelA}}
	days := Arrange(in)
	m := dayOfIDs(days)
	for _, s := range a {
		if m[s.ID] != 2 {
			t.Fatalf("西湖 stop on day %d: %v", m[s.ID], days)
		}
	}
	// Day 2 starts next to hotel B's side of 西湖 (the west) and ends near hotel A.
	for d, ids := range days {
		for _, perm := range permutations(ids) {
			if pathLen(in, d+1, perm) < pathLen(in, d+1, ids)-1 {
				t.Fatalf("day %d order %v is not the shortest (%v is)", d+1, ids, perm)
			}
		}
	}
}

func permutations(ids []int64) [][]int64 {
	if len(ids) <= 1 {
		return [][]int64{slices.Clone(ids)}
	}
	var out [][]int64
	for i := range ids {
		rest := slices.Concat(ids[:i], ids[i+1:])
		for _, p := range permutations(rest) {
			out = append(out, append([]int64{ids[i]}, p...))
		}
	}
	return out
}

// One hotel for the whole trip: the days go in different directions from
// it instead of rings around it.
func TestArrangeSharedHotel(t *testing.T) {
	hotel := &geo.Point{Lng: 120.16, Lat: 30.26}
	north := cluster(100, 3, 3, 120.16, 30.30)
	south := cluster(200, 0, 3, 120.16, 30.21)
	east := cluster(300, 6, 3, 120.21, 30.26)
	stops := slices.Concat(south, east, north)
	in := ArrangeInput{Days: 3, Stops: stops,
		Start: map[int]*geo.Point{2: hotel, 3: hotel}, End: map[int]*geo.Point{1: hotel, 2: hotel}}
	days := Arrange(in)
	m := dayOfIDs(days)
	for _, group := range [][]ArrangeStop{north, south, east} {
		d := m[group[0].ID]
		for _, s := range group {
			if m[s.ID] != d {
				t.Fatalf("a direction split over days: %v", days)
			}
		}
	}
	if m[south[0].ID] != 1 { // the trip's first stop is in the south
		t.Fatalf("day 1 should be the south: %v", days)
	}
}

func TestArrangeBalanceAndFixed(t *testing.T) {
	// 8 stops in one place, 1 far away, 3 days: at most 3 a day.
	stops := cluster(100, 0, 8, 120.15, 30.25)
	stops = append(stops, ArrangeStop{ID: 900, Order: 8, Lng: 121.4, Lat: 28.6})
	// Pinned: 101 on day 3 with the far one.
	stops[1].Fixed, stops[1].Day = true, 3
	days := Arrange(ArrangeInput{Days: 3, Stops: stops})
	total := 0
	for d, ids := range days {
		if len(ids) > 3 {
			t.Fatalf("day %d has %d stops: %v", d+1, len(ids), days)
		}
		total += len(ids)
	}
	m := dayOfIDs(days)
	if total != 9 || m[101] != 3 {
		t.Fatalf("days %v", days)
	}
	// More days than stops: some days stay empty.
	if days := Arrange(ArrangeInput{Days: 4, Stops: cluster(1, 0, 2, 120, 30)}); len(days) != 4 {
		t.Fatalf("days %v", days)
	}
	if days := Arrange(ArrangeInput{Days: 0}); len(days) != 0 {
		t.Fatalf("no days: %v", days)
	}
}

// Kept stops keep their order; the others go where they add the least way.
func TestArrangeKeepOrder(t *testing.T) {
	line := func(id int64, x float64, keep bool, order int) ArrangeStop {
		return ArrangeStop{ID: id, Lng: 120 + x, Lat: 30, Fixed: keep, Keep: keep, Day: 1, Order: order}
	}
	stops := []ArrangeStop{
		line(1, 0.00, true, 0), line(2, 0.04, true, 1), line(3, 0.02, true, 2), // the user's own (odd) order
		line(4, 0.01, false, 3), line(5, 0.05, false, 4),
	}
	got := Arrange(ArrangeInput{Days: 1, Stops: stops})[0]
	kept := slices.DeleteFunc(slices.Clone(got), func(id int64) bool { return id > 3 })
	if !reflect.DeepEqual(kept, []int64{1, 2, 3}) || len(got) != 5 {
		t.Fatalf("kept order changed: %v", got)
	}
	if i4, i1 := slices.Index(got, 4), slices.Index(got, 1); i4 != i1+1 {
		t.Fatalf("stop 4 should follow stop 1: %v", got)
	}
	// Without kept stops: along the line, from the start.
	for i := range stops {
		stops[i].Fixed, stops[i].Keep = false, false
	}
	start := &geo.Point{Lng: 120.06, Lat: 30}
	if got := Arrange(ArrangeInput{Days: 1, Stops: stops, Start: map[int]*geo.Point{1: start}})[0]; !reflect.DeepEqual(got, []int64{5, 2, 3, 4, 1}) {
		t.Fatalf("line from the east: %v", got)
	}
}

func TestPlanArrangement(t *testing.T) {
	wps := lodgingTrip()
	// Put A, B, C in the pool; keep D on day 2.
	for i := range wps {
		switch wps[i].Name {
		case "A", "B", "C":
			wps[i].Day = 0
		}
	}
	res, err := PlanArrangement(wps, ArrangeRequest{Scope: ArrangePool, Mode: "auto"}, 2, false)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[int64]ArrangeItem{}
	var order []int64
	for i, it := range res.Items {
		if it.Seq != i {
			t.Fatalf("seq %d at %d", it.Seq, i)
		}
		byID[it.ID] = it
		order = append(order, it.ID)
	}
	if len(res.Items) != len(wps) || res.Days != 2 || len(res.DayList) != 2 {
		t.Fatalf("arrangement %+v", res)
	}
	// Night 0 first, each night after its day, the unplanned stop first on its day.
	if order[0] != 10 || byID[4].Day != 2 || byID[9].Day != 2 || byID[5].Day == 0 {
		t.Fatalf("order %v items %+v", order, res.Items)
	}
	pos := func(id int64) int { return slices.Index(order, id) }
	if !(pos(11) < pos(9) && pos(9) < pos(4) && pos(4) < pos(20)) {
		t.Fatalf("day 2 order %v", order)
	}
	for _, d := range res.DayList {
		if d.Stops != len(d.IDs) || d.DistanceM <= 0 || d.DurationS <= 0 || d.StartLodgingID == nil || d.EndLodgingID == nil {
			t.Fatalf("day %+v", d)
		}
	}
	if _, err := PlanArrangement(wps, ArrangeRequest{Scope: ArrangeAll, Fixed: map[int64]int{9: 1}}, 2, false); err == nil {
		t.Fatal("an unplanned stop was pinned")
	}
	if _, err := PlanArrangement(wps, ArrangeRequest{Scope: ArrangeAll, Fixed: map[int64]int{1: 3}}, 2, false); err == nil {
		t.Fatal("a pin after the last day was accepted")
	}
	// Days derived from the stops when the trip has none.
	res, err = PlanArrangement(wps, ArrangeRequest{Scope: ArrangeAll}, 0, false)
	if err != nil || res.Days != 1 {
		t.Fatalf("derived days: %+v %v", res, err)
	}
}
