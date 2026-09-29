package handler

import (
	"fmt"
	"slices"
	"testing"
)

// wpsByName maps the waypoints of a TripDetail by name.
func wpsByName(t *testing.T, trip map[string]any) map[string]map[string]any {
	t.Helper()
	out := map[string]map[string]any{}
	for _, w := range trip["waypoints"].([]any) {
		m := w.(map[string]any)
		out[m["name"].(string)] = m
	}
	return out
}

// Lodging: one per night (night 0 = the evening before day 1), several
// nights at once or copied from another night, validated against the trip's
// days; it anchors the legs, is no stop in the statistics or the
// completion rate, is suggested at the end of the day, and forks copy it.
func TestLodging(t *testing.T) {
	e := setup(t)
	alice, _, _ := e.register("alice")
	bob, _, _ := e.register("bob")
	trip := e.must(200, "POST", "/trips", alice, map[string]any{"title": "杭州三日", "days": 3}).obj(t)
	tripID := id(trip)
	if num(trip["days"]) != 3 || trip["start_date"] != nil {
		t.Fatalf("days: %v", trip)
	}
	base := fmt.Sprintf("/trips/%d", tripID)
	e.must(200, "POST", base+"/waypoints/batch", alice, map[string]any{"items": []any{
		map[string]any{"name": "断桥残雪", "lng": 120.1513, "lat": 30.2610, "day": 1},
		map[string]any{"name": "楼外楼", "lng": 120.1437, "lat": 30.2556, "day": 1},
		map[string]any{"name": "灵隐寺", "lng": 120.1016, "lat": 30.2408, "day": 2},
		map[string]any{"name": "西溪湿地", "lng": 120.0700, "lat": 30.2700, "day": 3},
		map[string]any{"name": "河坊街", "lng": 120.1690, "lat": 30.2420},
	}})
	// Two nights at one hotel.
	two := e.must(200, "POST", base+"/lodging", alice, map[string]any{"day": 1, "nights": 2,
		"name": "湖滨酒店", "lng": 120.1650, "lat": 30.2600}).arr(t)
	if len(two) != 2 {
		t.Fatalf("lodging: %v", two)
	}
	for i, w := range two {
		m := w.(map[string]any)
		if m["kind"] != "lodging" || num(m["day"]) != float64(i+1) || m["planned"] != true || m["status"] != "todo" || m["category"] != "hotel" {
			t.Fatalf("lodging %d: %v", i, m)
		}
	}
	night1 := id(two[0].(map[string]any))
	e.must(409, "POST", base+"/lodging", alice, map[string]any{"day": 2, "name": "别家", "lng": 120.2, "lat": 30.3})
	e.must(400, "POST", base+"/lodging", alice, map[string]any{"day": 4, "name": "太晚", "lng": 120.2, "lat": 30.3})
	e.must(400, "POST", base+"/lodging", alice, map[string]any{"name": "哪天", "lng": 120.2, "lat": 30.3})
	e.must(400, "POST", base+"/waypoints", alice, map[string]any{"name": "x", "kind": "hostel", "lng": 120.2, "lat": 30.3})
	e.must(409, "POST", base+"/waypoints", alice, map[string]any{"name": "又一家", "kind": "lodging", "day": 1, "lng": 120.2, "lat": 30.3})
	e.must(404, "POST", base+"/lodging", bob, map[string]any{"day": 3, "copy_from": night1})
	// The night before day 1 (a waypoint body with kind), and night 3 copied from night 1.
	e.must(200, "POST", base+"/waypoints", alice, map[string]any{"name": "西湖边民宿", "kind": "lodging", "day": 0, "lng": 120.1550, "lat": 30.2650})
	copied := e.must(200, "POST", base+"/lodging", alice, map[string]any{"day": 3, "copy_from": night1}).arr(t)[0].(map[string]any)
	if copied["name"] != "湖滨酒店" || num(copied["lng"]) != 120.165 || copied["kind"] != "lodging" || num(copied["day"]) != 3 {
		t.Fatalf("copy_from: %v", copied)
	}
	// Replace night 3 with another hotel.
	e.must(200, "POST", base+"/lodging", alice, map[string]any{"day": 3, "replace": true, "name": "西溪酒店", "lng": 120.0750, "lat": 30.2750})

	d := e.must(200, "GET", base, alice, nil).obj(t)
	if num(d["waypoint_count"]) != 5 || num(d["planned_count"]) != 5 || num(d["days"]) != 3 {
		t.Fatalf("stats count lodging: %v", d)
	}
	byName := wpsByName(t, d)
	if len(byName) != 9-1 { // 5 stops + 4 lodging rows, 湖滨酒店 twice
		t.Fatalf("waypoints: %v", byName)
	}
	// Seq: each night after its day.
	var order []string
	for _, w := range d["waypoints"].([]any) {
		m := w.(map[string]any)
		order = append(order, fmt.Sprintf("%s@%v", m["name"], m["day"]))
	}
	want := []string{"西湖边民宿@0", "断桥残雪@1", "楼外楼@1", "湖滨酒店@1", "灵隐寺@2", "湖滨酒店@2", "西溪湿地@3", "西溪酒店@3", "河坊街@0"}
	if !slices.Equal(order, want) {
		t.Fatalf("order %v, want %v", order, want)
	}

	// Legs: day 1 from the night-0 inn to the hotel, day 2 from the hotel back to it.
	legs := e.must(200, "GET", base+"/legs", alice, nil).obj(t)
	var pairs []string
	for _, l := range legs["legs"].([]any) {
		m := l.(map[string]any)
		pairs = append(pairs, fmt.Sprintf("%v", m["day"]))
	}
	if len(pairs) != 3+2+2 { // inn→断桥→楼外楼→hotel, hotel→灵隐寺→hotel, hotel→西溪→西溪酒店
		t.Fatalf("legs %v", legs["legs"])
	}
	day1 := legs["days"].([]any)[0].(map[string]any)
	if num(day1["start_lodging_id"]) != num(byName["西湖边民宿"]["id"]) || num(day1["end_lodging_id"]) != float64(night1) || num(day1["stops"]) != 2 {
		t.Fatalf("day 1: %v", day1)
	}

	// Travel: at the end of day 1 the hotel is next; checking in there marks it.
	for _, n := range []string{"断桥残雪", "楼外楼"} {
		e.must(200, "POST", fmt.Sprintf("/waypoints/%d/checkin", int64(num(byName[n]["id"]))), alice, nil)
	}
	rec := e.must(200, "GET", base+"/recommend", alice, nil).obj(t)
	if next := rec["next_planned"].(map[string]any); next["kind"] != "lodging" || int64(num(next["id"])) != night1 {
		t.Fatalf("next stop: %v", rec["next_planned"])
	}
	if s := rec["suggestions"].([]any)[0].(map[string]any); s["reason"] != "今晚的住宿" {
		t.Fatalf("suggestion: %v", s)
	}
	ci := e.must(200, "POST", base+"/checkin", alice, map[string]any{"lng": 120.1651, "lat": 30.2601}).obj(t)
	if w := ci["waypoint"].(map[string]any); int64(num(w["id"])) != night1 || ci["matched_plan"] != true {
		t.Fatalf("hotel check-in matched %v", ci)
	}
	cmp := e.must(200, "GET", base+"/compare", alice, nil).obj(t)
	if num(cmp["completion_rate"]) != 0.4 || len(cmp["lodging"].([]any)) != 4 || len(cmp["todo"].([]any)) != 3 ||
		num(cmp["planned"].(map[string]any)["count"]) != 5 || num(cmp["actual"].(map[string]any)["count"]) != 2 {
		t.Fatalf("compare: %v", cmp)
	}
	if d := e.must(200, "GET", base, alice, nil).obj(t); num(d["visited_count"]) != 2 {
		t.Fatalf("visited_count counts the hotel: %v", d["visited_count"])
	}

	// A fork copies the lodging and the days.
	e.must(200, "PATCH", base, alice, map[string]any{"visibility": "public"})
	fork := e.must(200, "POST", base+"/fork", bob, map[string]any{}).obj(t)
	fb := wpsByName(t, fork)
	if num(fork["days"]) != 3 || fb["西溪酒店"]["kind"] != "lodging" || num(fb["西溪酒店"]["day"]) != 3 || fb["湖滨酒店"]["status"] != "todo" ||
		num(fork["planned_count"]) != 5 {
		t.Fatalf("fork: %v", fork)
	}

	// Kind changes are validated like creations.
	e.must(409, "PATCH", fmt.Sprintf("/waypoints/%d", int64(num(byName["河坊街"]["id"]))), alice, map[string]any{"kind": "lodging", "day": 2})
	moved := e.must(200, "PATCH", fmt.Sprintf("/waypoints/%d", int64(num(byName["西溪酒店"]["id"]))), alice, map[string]any{"kind": "stop", "day": 0}).obj(t)
	if moved["kind"] != "stop" {
		t.Fatalf("kind change: %v", moved)
	}
	e.must(200, "PATCH", fmt.Sprintf("/waypoints/%d", int64(num(byName["西溪酒店"]["id"]))), alice, map[string]any{"kind": "lodging", "day": 3})
}

// Days: set explicitly without dates, derived from the dates, and cutting
// them moves the later days' stops to 未分天 and drops (or keeps as stops)
// the later nights' lodging.
func TestTripDaysEditing(t *testing.T) {
	e := setup(t)
	alice, _, _ := e.register("alice")
	trip := e.must(200, "POST", "/trips", alice, map[string]any{"title": "台州四日", "days": 4}).obj(t)
	base := fmt.Sprintf("/trips/%d", id(trip))
	e.must(200, "POST", base+"/waypoints/batch", alice, map[string]any{"items": []any{
		map[string]any{"name": "府城", "lng": 121.12, "lat": 28.85, "day": 1},
		map[string]any{"name": "紫阳街", "lng": 121.13, "lat": 28.86, "day": 3},
		map[string]any{"name": "大陈岛", "lng": 121.90, "lat": 28.45, "day": 4},
	}})
	e.must(200, "POST", base+"/lodging", alice, map[string]any{"day": 1, "nights": 2, "name": "古城客栈", "lng": 121.125, "lat": 28.855})
	e.must(200, "POST", base+"/lodging", alice, map[string]any{"day": 3, "name": "海岛民宿", "lng": 121.91, "lat": 28.46})
	e.must(200, "POST", base+"/lodging", alice, map[string]any{"day": 4, "name": "古城客栈", "lng": 121.125, "lat": 28.855})
	e.must(400, "PATCH", base, alice, map[string]any{"days": 400})

	// 4 → 2: 紫阳街 and 大陈岛 to 未分天; night 3's inn becomes a stop (no other night), night 4's is dropped.
	d := e.must(200, "PATCH", base, alice, map[string]any{"days": 2}).obj(t)
	w := wpsByName(t, d)
	if num(d["days"]) != 2 || num(w["紫阳街"]["day"]) != 0 || num(w["大陈岛"]["day"]) != 0 || num(w["府城"]["day"]) != 1 ||
		w["海岛民宿"]["kind"] != "stop" || num(w["海岛民宿"]["day"]) != 0 {
		t.Fatalf("after cutting days: %v", d["waypoints"])
	}
	lodging := 0
	for _, x := range d["waypoints"].([]any) {
		if m := x.(map[string]any); m["kind"] == "lodging" {
			lodging++
			if num(m["day"]) > 2 {
				t.Fatalf("lodging of a night that is gone: %v", m)
			}
		}
	}
	if lodging != 2 {
		t.Fatalf("lodging nights: %d", lodging)
	}
	// Dates: the days follow the start date; the end date follows the days.
	d = e.must(200, "PATCH", base, alice, map[string]any{"start_date": "2026-10-01", "days": 3}).obj(t)
	if d["end_date"] != "2026-10-03" || num(d["days"]) != 3 {
		t.Fatalf("dates from days: %v %v", d["end_date"], d["days"])
	}
	e.must(400, "PATCH", base, alice, map[string]any{"end_date": "2026-10-05", "days": 3})
	d = e.must(200, "PATCH", base, alice, map[string]any{"end_date": "2026-10-05"}).obj(t)
	if num(d["days"]) != 5 {
		t.Fatalf("days from dates: %v", d["days"])
	}
	e.must(400, "POST", base+"/lodging", alice, map[string]any{"day": 6, "name": "x", "lng": 121.1, "lat": 28.8})
	// Clearing the dates keeps the days.
	d = e.must(200, "PATCH", base, alice, map[string]any{"start_date": nil, "end_date": nil}).obj(t)
	if num(d["days"]) != 5 || d["start_date"] != nil {
		t.Fatalf("days without dates: %v", d["days"])
	}
}

// One-click arrangement: a proposal first, then applied with consistent
// seq, lodging as the day anchors and pinned stops kept.
func TestArrange(t *testing.T) {
	e := setup(t)
	alice, _, _ := e.register("alice")
	bob, _, _ := e.register("bob")
	trip := e.must(200, "POST", "/trips", alice, map[string]any{"title": "杭州两日", "days": 2}).obj(t)
	base := fmt.Sprintf("/trips/%d", id(trip))
	// The wish list: 西湖 and 西溪 stops mixed up, all 未分天.
	pool := e.must(200, "POST", base+"/waypoints/batch", alice, map[string]any{"items": []any{
		map[string]any{"name": "断桥残雪", "lng": 120.1513, "lat": 30.2610},
		map[string]any{"name": "西溪湿地", "lng": 120.0700, "lat": 30.2700},
		map[string]any{"name": "楼外楼", "lng": 120.1437, "lat": 30.2556},
		map[string]any{"name": "河渚街", "lng": 120.0650, "lat": 30.2750},
		map[string]any{"name": "雷峰塔", "lng": 120.1488, "lat": 30.2317},
		map[string]any{"name": "西溪天堂", "lng": 120.0800, "lat": 30.2650},
	}}).arr(t)
	idOf := map[string]int64{}
	for _, w := range pool {
		m := w.(map[string]any)
		idOf[m["name"].(string)] = id(m)
	}
	hotel := id(e.must(200, "POST", base+"/lodging", alice, map[string]any{"day": 1, "name": "西溪酒店", "lng": 120.0760, "lat": 30.2720}).arr(t)[0].(map[string]any))
	hotel2 := id(e.must(200, "POST", base+"/lodging", alice, map[string]any{"day": 2, "name": "湖滨酒店", "lng": 120.1650, "lat": 30.2600}).arr(t)[0].(map[string]any))

	e.must(400, "POST", base+"/arrange", alice, map[string]any{"scope": "some"})
	e.must(400, "POST", base+"/arrange", alice, map[string]any{"fixed": map[string]int{fmt.Sprint(idOf["楼外楼"]): 3}})
	e.must(404, "POST", base+"/arrange", bob, map[string]any{})

	prop := e.must(200, "POST", base+"/arrange", alice, map[string]any{"scope": "pool", "mode": "auto"}).obj(t)
	if prop["applied"] != false || num(prop["days"]) != 2 || len(prop["items"].([]any)) != 8 || len(prop["day_totals"].([]any)) != 2 {
		t.Fatalf("proposal: %v", prop)
	}
	if d := e.must(200, "GET", base, alice, nil).obj(t); num(wpsByName(t, d)["西溪湿地"]["day"]) != 0 {
		t.Fatal("a proposal changed the trip")
	}
	// The day ending at the 西溪 hotel is the 西溪 day; the next goes on to 西湖.
	dayOf := func(res map[string]any) map[int64]int {
		m := map[int64]int{}
		for _, it := range res["items"].([]any) {
			x := it.(map[string]any)
			m[id(x)] = int(num(x["day"]))
		}
		return m
	}
	pd := dayOf(prop)
	for _, n := range []string{"西溪湿地", "河渚街", "西溪天堂"} {
		if pd[idOf[n]] != 1 {
			t.Fatalf("%s on day %d: %v", n, pd[idOf[n]], prop["items"])
		}
	}
	for _, n := range []string{"断桥残雪", "楼外楼", "雷峰塔"} {
		if pd[idOf[n]] != 2 {
			t.Fatalf("%s on day %d: %v", n, pd[idOf[n]], prop["items"])
		}
	}
	d1 := prop["day_totals"].([]any)[0].(map[string]any)
	if num(d1["stops"]) != 3 || int64(num(d1["end_lodging_id"])) != hotel || d1["start_lodging_id"] != nil || num(d1["duration_s"]) <= 0 {
		t.Fatalf("day 1 totals: %v", d1)
	}

	// Pin 雷峰塔 to day 1 and apply.
	res := e.must(200, "POST", base+"/arrange", alice, map[string]any{"scope": "all", "apply": true,
		"fixed": map[string]int{fmt.Sprint(idOf["雷峰塔"]): 1}}).obj(t)
	if res["applied"] != true || dayOf(res)[idOf["雷峰塔"]] != 1 {
		t.Fatalf("applied: %v", res)
	}
	d := e.must(200, "GET", base, alice, nil).obj(t)
	var seqs []int
	for i, w := range d["waypoints"].([]any) {
		m := w.(map[string]any)
		seqs = append(seqs, int(num(m["seq"])))
		if int(num(m["seq"])) != i {
			t.Fatalf("seq not consecutive: %v", seqs)
		}
		if id(m) == hotel && i != 3 || id(m) == hotel2 && i != 7 { // after each day's stops
			t.Fatalf("hotel at %d: %v", i, d["waypoints"])
		}
		if day := int(num(m["day"])); m["kind"] == "stop" && dayOf(res)[id(m)] != day {
			t.Fatalf("stored day %d for %v", day, m)
		}
	}
	if len(res["waypoints"].([]any)) != 8 {
		t.Fatalf("applied waypoints: %v", res["waypoints"])
	}
	// Without days, the arrangement picks some and the trip keeps them.
	t2 := e.must(200, "POST", "/trips", alice, map[string]any{"title": "无天数"}).obj(t)
	b2 := fmt.Sprintf("/trips/%d", id(t2))
	e.must(200, "POST", b2+"/waypoints/batch", alice, map[string]any{"items": []any{
		map[string]any{"name": "a", "lng": 120.15, "lat": 30.26}, map[string]any{"name": "b", "lng": 120.16, "lat": 30.26}}})
	e.must(200, "POST", b2+"/arrange", alice, map[string]any{"apply": true, "days": 2})
	if d := e.must(200, "GET", b2, alice, nil).obj(t); num(d["days"]) != 2 {
		t.Fatalf("days after arranging: %v", d["days"])
	}
}

// Several co-authors (not only the partner) can be invited and accept; the
// trip lists them all with their avatars.
func TestSeveralMembers(t *testing.T) {
	e := setup(t)
	alice, _, _ := e.register("alice")
	bob, _, bobID := e.register("bob")
	carol, _, carolID := e.register("carol")
	dave, _, _ := e.register("dave")
	e.must(200, "PATCH", "/me", bob, map[string]any{"avatar_url": "/uploads/2026/09/bob.jpg"})
	tripID := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "三人行"}).obj(t))
	base := fmt.Sprintf("/trips/%d", tripID)
	e.must(200, "POST", base+"/members", alice, map[string]any{"username": "bob"})
	list := e.must(200, "POST", base+"/members", alice, map[string]any{"username": "@carol"}).arr(t)
	if len(list) != 3 {
		t.Fatalf("members: %v", list)
	}
	e.must(409, "POST", base+"/members", alice, map[string]any{"username": "carol"})
	e.must(403, "POST", base+"/members", bob, map[string]any{"username": "dave"}) // only the owner invites
	e.must(200, "POST", base+"/members/accept", bob, nil)
	e.must(200, "POST", base+"/members/accept", carol, nil)
	d := e.must(200, "GET", base, alice, nil).obj(t)
	members := d["members"].([]any)
	if len(members) != 2 {
		t.Fatalf("members: %v", members)
	}
	got := map[int64]map[string]any{}
	for _, m := range members {
		u := m.(map[string]any)
		if _, ok := u["avatar_url"]; !ok {
			t.Fatalf("no avatar_url: %v", u)
		}
		got[id(u)] = u
	}
	if got[bobID]["avatar_url"] != "/uploads/2026/09/bob.jpg" || got[carolID] == nil {
		t.Fatalf("members: %v", members)
	}
	// Both can edit; others cannot.
	e.must(200, "POST", base+"/waypoints", carol, map[string]any{"name": "x", "lng": 120.1, "lat": 30.2})
	e.must(200, "POST", base+"/lodging", bob, map[string]any{"day": 1, "name": "y", "lng": 120.1, "lat": 30.2})
	e.must(404, "POST", base+"/waypoints", dave, map[string]any{"name": "x", "lng": 120.1, "lat": 30.2})
	if l := e.must(200, "GET", base+"/members", carol, nil).arr(t); len(l) != 3 {
		t.Fatalf("member list: %v", l)
	}
}
