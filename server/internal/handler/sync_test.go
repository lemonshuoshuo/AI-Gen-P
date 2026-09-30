package handler

import (
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"triphub/internal/model"
)

// revisionOf reads GET /trips/:id/revision as token sees it.
func (e *env) revisionOf(tripID int64, token string) map[string]any {
	e.t.Helper()
	return e.must(200, "GET", fmt.Sprintf("/trips/%d/revision", tripID), token, nil).obj(e.t)
}

// planOf returns the waypoint IDs of a TripDetail in seq order.
func planOf(trip map[string]any) []int64 {
	var ids []int64
	for _, w := range trip["waypoints"].([]any) {
		ids = append(ids, id(w.(map[string]any)))
	}
	return ids
}

// waypointOf finds a waypoint of a TripDetail by ID (nil: not there).
func waypointOf(trip map[string]any, wid int64) map[string]any {
	for _, w := range trip["waypoints"].([]any) {
		if m := w.(map[string]any); id(m) == wid {
			return m
		}
	}
	return nil
}

// Every kind of change of a trip counts one revision, made by the user who
// changed it; requests that change nothing (and likes, comments, GPS
// samples) count none.
func TestRevisionCountsEveryChange(t *testing.T) {
	e := setup(t)
	alice, _, aliceID := e.register("alice")
	bob, _, bobID := e.register("bob")
	carol, _, carolID := e.register("carol")
	admin := e.adminToken()
	adminID := id(e.must(200, "GET", "/me", admin, nil).obj(t))
	trip := e.must(200, "POST", "/trips", alice, map[string]any{"title": "杭州两日", "days": 2, "visibility": "public"}).obj(t)
	tid := id(trip)
	base := fmt.Sprintf("/trips/%d", tid)
	if num(trip["revision"]) != 1 {
		t.Fatalf("a new trip is at revision 1: %v", trip["revision"])
	}
	if r := e.revisionOf(tid, alice); num(r["revision"]) != 1 || id(r["updated_by"].(map[string]any)) != aliceID {
		t.Fatalf("new trip revision: %v", r)
	}
	cur := int64(1)
	step := func(name string, want, who int64, fn func()) {
		t.Helper()
		fn()
		r := e.revisionOf(tid, alice)
		if got := int64(num(r["revision"])); got != cur+want {
			t.Fatalf("%s: revision %d, want %d", name, got, cur+want)
		}
		if want > 0 {
			if by, _ := r["updated_by"].(map[string]any); by == nil || id(by) != who {
				t.Fatalf("%s: updated_by %v, want user %d", name, r["updated_by"], who)
			}
		}
		cur += want
	}
	wp := func(w int64) string { return fmt.Sprintf("/waypoints/%d", w) }

	step("PATCH trip", 1, aliceID, func() { e.must(200, "PATCH", base, alice, map[string]any{"summary": "西湖边走走"}) })
	step("PATCH trip without changes", 0, 0, func() { e.must(200, "PATCH", base, alice, map[string]any{}) })
	var w1, w2, w3, w4 int64
	step("batch", 1, aliceID, func() {
		wps := e.must(200, "POST", base+"/waypoints/batch", alice, map[string]any{"items": []any{
			map[string]any{"name": "断桥残雪", "lng": 120.1513, "lat": 30.2610, "day": 1},
			map[string]any{"name": "楼外楼", "lng": 120.1437, "lat": 30.2556, "day": 1},
			map[string]any{"name": "雷峰塔", "lng": 120.1488, "lat": 30.2317, "day": 2},
		}}).arr(t)
		w1, w2, w3 = id(wps[0].(map[string]any)), id(wps[1].(map[string]any)), id(wps[2].(map[string]any))
	})
	step("create", 1, aliceID, func() {
		w4 = id(e.must(200, "POST", base+"/waypoints", alice, map[string]any{"name": "河坊街", "lng": 120.1690, "lat": 30.2420}).obj(t))
	})
	step("PATCH waypoint", 1, aliceID, func() { e.must(200, "PATCH", wp(w1), alice, map[string]any{"note": "清晨人少"}) })
	step("PATCH waypoint without changes", 0, 0, func() { e.must(200, "PATCH", wp(w1), alice, map[string]any{"note": "清晨人少"}) })
	step("order", 1, aliceID, func() {
		e.must(200, "PUT", base+"/waypoints/order", alice, map[string]any{"ids": []int64{w2, w1, w3, w4}})
	})
	step("same order", 0, 0, func() {
		e.must(200, "PUT", base+"/waypoints/order", alice, map[string]any{"ids": []int64{w2, w1, w3, w4}})
	})
	step("lodging", 1, aliceID, func() {
		e.must(200, "POST", base+"/lodging", alice, map[string]any{"day": 1, "name": "湖滨酒店", "lng": 120.1650, "lat": 30.2600})
	})
	step("arrange", 1, aliceID, func() { e.must(200, "POST", base+"/arrange", alice, map[string]any{"apply": true}) })
	step("invite", 1, aliceID, func() { e.must(200, "POST", base+"/members", alice, map[string]any{"username": "bob"}) })
	step("accept", 1, bobID, func() { e.must(200, "POST", base+"/members/accept", bob, nil) })
	step("check-in (starts the trip)", 1, bobID, func() {
		e.must(200, "POST", base+"/checkin", bob, map[string]any{"waypoint_id": w1})
	})
	step("the same check-in again", 0, 0, func() { e.must(200, "POST", base+"/checkin", bob, map[string]any{"waypoint_id": w1}) })
	step("skip", 1, bobID, func() { e.must(200, "POST", wp(w2)+"/skip", bob, nil) })
	step("reset", 1, bobID, func() { e.must(200, "POST", wp(w2)+"/reset", bob, nil) })
	step("reset again", 0, 0, func() { e.must(200, "POST", wp(w2)+"/reset", bob, nil) })
	step("waypoint check-in", 1, aliceID, func() { e.must(200, "POST", wp(w2)+"/checkin", alice, map[string]any{}) })
	var photo int64
	step("photo upload", 1, aliceID, func() {
		r := e.upload(base+"/photos", alice, testJPEG(t, 64, 48), map[string]string{"waypoint_id": fmt.Sprint(w1)})
		if r.status != 200 {
			t.Fatalf("upload: %d %s", r.status, r.body)
		}
		photo = id(r.obj(t)["photo"].(map[string]any))
	})
	step("photo linked elsewhere", 1, aliceID, func() {
		e.must(200, "PATCH", fmt.Sprintf("/photos/%d", photo), alice, map[string]any{"waypoint_id": w2})
	})
	step("photo deleted", 1, bobID, func() { e.must(200, "DELETE", fmt.Sprintf("/photos/%d", photo), bob, nil) })
	step("photo deleted again", 0, 0, func() { e.must(200, "DELETE", fmt.Sprintf("/photos/%d", photo), bob, nil) })
	now := time.Now().UnixMilli()
	point := func(ms int64) map[string]any {
		return map[string]any{"segment": 1, "points": []any{map[string]any{"lng": 120.15, "lat": 30.26, "t": ms}}}
	}
	step("first track points", 1, aliceID, func() { e.must(200, "POST", base+"/track", alice, point(now-60000)) })
	step("more track points", 0, 0, func() { e.must(200, "POST", base+"/track", alice, point(now)) })
	step("track cleared", 1, aliceID, func() { e.must(200, "DELETE", base+"/track", alice, nil) })
	step("track imported", 1, bobID, func() {
		if r := e.upload(base+"/track/import", bob, gpxFile(true, [2]float64{120.15, 30.26}, [2]float64{120.151, 30.26}), nil); r.status != 200 {
			t.Fatalf("import: %d %s", r.status, r.body)
		}
	})
	step("likes, favorites and comments", 0, 0, func() {
		e.must(200, "POST", base+"/like", carol, nil)
		e.must(200, "POST", base+"/favorite", carol, nil)
		e.must(200, "POST", base+"/comments", carol, map[string]any{"content": "好玩吗"})
	})
	step("share code reset", 1, aliceID, func() { e.must(200, "POST", base+"/share-code/reset", alice, nil) })
	step("featured by an admin", 1, adminID, func() {
		e.must(200, "PATCH", fmt.Sprintf("/admin/trips/%d", tid), admin, map[string]any{"featured": true})
	})
	step("waypoint deleted", 1, aliceID, func() { e.must(200, "DELETE", wp(w4), alice, nil) })
	step("waypoint deleted again", 0, 0, func() { e.must(200, "DELETE", wp(w4), alice, nil) })
	step("member leaves", 1, bobID, func() { e.must(200, "DELETE", fmt.Sprintf("%s/members/%d", base, bobID), bob, nil) })
	step("invite carol", 1, aliceID, func() { e.must(200, "POST", base+"/members", alice, map[string]any{"username": "carol"}) })
	step("carol declines", 1, carolID, func() { e.must(200, "POST", base+"/members/decline", carol, nil) })

	// The trip and its cards carry the revision.
	if d := e.must(200, "GET", base, alice, nil).obj(t); int64(num(d["revision"])) != cur {
		t.Fatalf("TripDetail revision %v, want %d", d["revision"], cur)
	}
	if card := items(t, e.must(200, "GET", "/me/trips", alice, nil))[0].(map[string]any); int64(num(card["revision"])) != cur {
		t.Fatalf("TripCard revision %v, want %d", card["revision"], cur)
	}
}

// GET /trips/:id/revision is visible like the trip; who changed it and who
// is editing only to members, and nothing of an ongoing trip's progress to
// those who may not see it.
func TestRevisionVisibility(t *testing.T) {
	e := setup(t)
	alice, _, aliceID := e.register("alice")
	carol, _, _ := e.register("carol")
	trip := e.must(200, "POST", "/trips", alice, map[string]any{"title": "私密"}).obj(t)
	tid := id(trip)
	path := fmt.Sprintf("/trips/%d/revision", tid)
	e.must(404, "GET", path, "", nil)
	e.must(404, "GET", path, carol, nil)
	e.must(404, "GET", "/trips/999999/revision", alice, nil)
	e.must(200, "PATCH", fmt.Sprintf("/trips/%d", tid), alice, map[string]any{"visibility": "unlisted"})
	e.must(404, "GET", path, carol, nil)
	code := e.must(200, "GET", fmt.Sprintf("/trips/%d", tid), alice, nil).obj(t)["share_code"].(string)
	viaShare := e.must(200, "GET", path+"?share_code="+code, carol, nil).obj(t)
	if num(viaShare["revision"]) != 2 || viaShare["updated_by"] != nil || len(viaShare["editors"].([]any)) != 0 ||
		viaShare["updated_at"] == "" {
		t.Fatalf("share-code viewer: %v", viaShare)
	}
	mine := e.revisionOf(tid, alice)
	if num(mine["revision"]) != 2 || id(mine["updated_by"].(map[string]any)) != aliceID || mine["updated_at"] != viaShare["updated_at"] {
		t.Fatalf("member: %v", mine)
	}
	// Ongoing without live sharing: others learn nothing of its changes.
	e.must(200, "PATCH", fmt.Sprintf("/trips/%d", tid), alice, map[string]any{"visibility": "public", "phase": "ongoing"})
	masked := e.revisionOf(tid, carol)
	if num(masked["revision"]) != 0 || masked["updated_at"] != e.revisionOf(tid, "")["updated_at"] ||
		masked["updated_at"] != e.must(200, "GET", fmt.Sprintf("/trips/%d", tid), carol, nil).obj(t)["created_at"] {
		t.Fatalf("masked revision: %v", masked)
	}
	if d := e.must(200, "GET", fmt.Sprintf("/trips/%d", tid), carol, nil).obj(t); num(d["revision"]) != 0 {
		t.Fatalf("masked TripDetail revision: %v", d["revision"])
	}
	e.must(200, "PATCH", fmt.Sprintf("/trips/%d", tid), alice, map[string]any{"live_share": true})
	if r := e.revisionOf(tid, carol); num(r["revision"]) != 4 || r["updated_by"] != nil {
		t.Fatalf("live-shared trip: %v", r)
	}
}

// Members' heartbeats (POST /trips/:id/editing) list them as editors until
// they leave or stop sending them.
func TestEditingPresence(t *testing.T) {
	e := setup(t)
	alice, _, aliceID := e.register("alice")
	bob, _, bobID := e.register("bob")
	carol, _, _ := e.register("carol")
	tid := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "一起改"}).obj(t))
	path := fmt.Sprintf("/trips/%d/editing", tid)
	e.must(200, "POST", fmt.Sprintf("/trips/%d/members", tid), alice, map[string]any{"username": "bob"})
	// Invited, not yet a member: may watch, not edit.
	if r := e.revisionOf(tid, bob); r["updated_by"] == nil {
		t.Fatalf("invitee sees who changed the trip: %v", r)
	}
	e.must(403, "POST", path, bob, map[string]any{"active": true})
	e.must(200, "POST", fmt.Sprintf("/trips/%d/members/accept", tid), bob, nil)
	editorIDs := func(r map[string]any) []int64 {
		var ids []int64
		for _, ed := range r["editors"].([]any) {
			m := ed.(map[string]any)
			if m["since"] == "" || m["last_seen"] == "" {
				t.Fatalf("editor without times: %v", m)
			}
			ids = append(ids, id(m["user"].(map[string]any)))
		}
		return ids
	}
	if got := editorIDs(e.must(200, "POST", path, alice, map[string]any{"active": true}).obj(t)); !slices.Equal(got, []int64{aliceID}) {
		t.Fatalf("editors after alice's heartbeat: %v", got)
	}
	e.must(200, "POST", path, bob, nil) // active by default
	e.must(200, "POST", path, alice, map[string]any{"active": true})
	r := e.revisionOf(tid, bob)
	if got := editorIDs(r); !slices.Equal(got, []int64{aliceID, bobID}) {
		t.Fatalf("editors (earliest first): %v", got)
	}
	if u := r["editors"].([]any)[1].(map[string]any)["user"].(map[string]any); u["nickname"] != "bob" || u["username"] != "bob" {
		t.Fatalf("editor user: %v", u)
	}
	e.must(404, "POST", path, carol, nil)
	e.must(401, "POST", path, "", nil)
	e.must(200, "PATCH", fmt.Sprintf("/trips/%d", tid), alice, map[string]any{"visibility": "public"})
	e.must(403, "POST", path, carol, nil)
	if r := e.revisionOf(tid, carol); len(r["editors"].([]any)) != 0 || r["updated_by"] != nil {
		t.Fatalf("editors shown to a non-member: %v", r)
	}
	if got := editorIDs(e.must(200, "POST", path, bob, map[string]any{"active": false}).obj(t)); !slices.Equal(got, []int64{aliceID}) {
		t.Fatalf("editors after bob left: %v", got)
	}
}

func TestPresenceTTL(t *testing.T) {
	p := newPresence(45 * time.Second)
	t0 := time.Date(2026, 9, 29, 10, 0, 0, 0, time.UTC)
	a, b := UserBrief{ID: 1, Nickname: "甲"}, UserBrief{ID: 2, Nickname: "乙"}
	ids := func(eds []editorEntry) []int64 {
		var out []int64
		for _, e := range eds {
			out = append(out, e.user.ID)
		}
		return out
	}
	p.beat(7, b, t0.Add(10*time.Second))
	p.beat(7, a, t0)
	p.beat(7, a, t0.Add(30*time.Second)) // a heartbeat keeps the session's start
	p.beat(8, b, t0)
	eds := p.editors(7, t0.Add(40*time.Second))
	if !slices.Equal(ids(eds), []int64{1, 2}) || !eds[0].since.Equal(t0) || !eds[0].seen.Equal(t0.Add(30*time.Second)) {
		t.Fatalf("editors at +40s: %+v", eds)
	}
	if got := ids(p.editors(7, t0.Add(56*time.Second))); !slices.Equal(got, []int64{1}) { // b: last seen 46 s ago
		t.Fatalf("editors at +56s: %v", got)
	}
	if got := p.editors(7, t0.Add(76*time.Second)); len(got) != 0 {
		t.Fatalf("editors at +76s: %v", got)
	}
	p.beat(7, a, t0.Add(100*time.Second)) // editing again: a new session
	if eds := p.editors(7, t0.Add(101*time.Second)); len(eds) != 1 || !eds[0].since.Equal(t0.Add(100*time.Second)) {
		t.Fatalf("new session: %+v", eds)
	}
	p.leave(7, 1)
	if got := p.editors(7, t0.Add(101*time.Second)); len(got) != 0 {
		t.Fatalf("after leaving: %v", got)
	}
	p.cleanup(t0.Add(time.Hour))
	if p.n != 0 || len(p.trips) != 0 {
		t.Fatalf("after cleanup: %d entries in %d trips", p.n, len(p.trips))
	}
}

// PUT /trips/:id/plan saves an editor's draft at once: listed waypoints are
// updated, new ones created, planned ones left out deleted (history kept),
// all in one revision; a draft of an older revision is refused unless forced.
func TestSavePlan(t *testing.T) {
	e := setup(t)
	alice, _, aliceID := e.register("alice")
	bob, _, bobID := e.register("bob")
	carol, _, _ := e.register("carol")
	tid := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "杭州两日", "days": 2}).obj(t))
	base := fmt.Sprintf("/trips/%d", tid)
	e.must(200, "POST", base+"/members", alice, map[string]any{"username": "bob"})
	e.must(200, "POST", base+"/members/accept", bob, nil)
	wps := e.must(200, "POST", base+"/waypoints/batch", alice, map[string]any{"items": []any{
		map[string]any{"name": "断桥残雪", "lng": 120.1513, "lat": 30.2610, "day": 1},
		map[string]any{"name": "楼外楼", "lng": 120.1437, "lat": 30.2556, "day": 1},
		map[string]any{"name": "灵隐寺", "lng": 120.1016, "lat": 30.2408, "day": 2},
		map[string]any{"name": "河坊街", "lng": 120.1690, "lat": 30.2420},
	}}).arr(t)
	a, b, c, d := id(wps[0].(map[string]any)), id(wps[1].(map[string]any)), id(wps[2].(map[string]any)), id(wps[3].(map[string]any))
	l1 := id(e.must(200, "POST", base+"/lodging", alice, map[string]any{"day": 1, "name": "湖滨酒店", "lng": 120.1650, "lat": 30.2600}).arr(t)[0].(map[string]any))
	get := func() map[string]any { return e.must(200, "GET", base, alice, nil).obj(t) }
	trip := get()
	rev := int64(num(trip["revision"]))
	if !slices.Equal(planOf(trip), []int64{a, b, l1, c, d}) {
		t.Fatalf("initial order: %v", planOf(trip))
	}

	// Checks.
	e.must(404, "PUT", base+"/plan", carol, map[string]any{"base_revision": rev, "waypoints": []any{}})
	e.must(400, "PUT", base+"/plan", alice, map[string]any{"base_revision": rev})
	e.must(400, "PUT", base+"/plan", alice, map[string]any{"waypoints": []any{}})
	bad := e.must(400, "PUT", base+"/plan", alice, map[string]any{"base_revision": rev, "waypoints": []any{
		map[string]any{"id": a}, map[string]any{"id": 999999, "client_key": "x"}}}).obj(t)
	if num(bad["index"]) != 1 || bad["error"].(map[string]any)["message"] != "第 2 项：地点 999999 不在这个旅程中，请刷新后重试" {
		t.Fatalf("unknown id: %v", bad)
	}
	for _, body := range []map[string]any{
		{"base_revision": rev, "waypoints": []any{map[string]any{"id": a}, map[string]any{"id": a}}},
		{"base_revision": rev, "waypoints": []any{map[string]any{"client_key": "n", "name": "无坐标"}}},
		{"base_revision": rev, "waypoints": []any{map[string]any{"client_key": "k", "name": "甲", "lng": 120.1, "lat": 30.2},
			map[string]any{"client_key": "k", "name": "乙", "lng": 120.1, "lat": 30.2}}},
		{"base_revision": rev, "trip": map[string]any{"title": " "}, "waypoints": []any{}},
	} {
		e.must(400, "PUT", base+"/plan", alice, body)
	}
	if r := get(); int64(num(r["revision"])) != rev || len(r["waypoints"].([]any)) != 5 {
		t.Fatalf("refused plans changed the trip: %v", r)
	}

	// A plan: reordered, one note changed, a new stop, the trip retitled;
	// the stops left out are deleted. One revision.
	res := e.must(200, "PUT", base+"/plan", alice, map[string]any{
		"base_revision": rev,
		"trip":          map[string]any{"title": "杭州两日·改"},
		"waypoints": []any{
			map[string]any{"id": b, "client_key": "b", "note": "先吃饭"},
			map[string]any{"id": a, "client_key": "a"},
			map[string]any{"client_key": "new-1", "name": "雷峰塔", "lng": 120.1488, "lat": 30.2317, "day": 2, "category": "scenic",
				"status": "visited", "planned": false},
			map[string]any{"id": l1},
		},
	}).obj(t)
	trip = res["trip"].(map[string]any)
	idMap := res["id_map"].(map[string]any)
	n1 := int64(num(idMap["new-1"]))
	if int64(num(trip["revision"])) != rev+1 || trip["title"] != "杭州两日·改" || int64(num(idMap["a"])) != a ||
		int64(num(idMap["b"])) != b || n1 == 0 || len(idMap) != 3 {
		t.Fatalf("saved plan: revision %v, title %v, id_map %v", trip["revision"], trip["title"], idMap)
	}
	if got := planOf(trip); !slices.Equal(got, []int64{b, a, n1, l1}) {
		t.Fatalf("order: %v", got)
	}
	if !slices.Equal(ids(t, res["deleted"]), []int64{c, d}) || len(res["kept"].([]any)) != 0 {
		t.Fatalf("deleted %v, kept %v", res["deleted"], res["kept"])
	}
	nw := waypointOf(trip, n1)
	if nw["planned"] != true || nw["status"] != "todo" || nw["kind"] != "stop" || num(nw["day"]) != 2 || nw["city"] != "杭州市" ||
		waypointOf(trip, b)["note"] != "先吃饭" || num(waypointOf(trip, n1)["seq"]) != 2 {
		t.Fatalf("new waypoint %v, b %v", nw, waypointOf(trip, b))
	}
	if r := e.revisionOf(tid, bob); int64(num(r["revision"])) != rev+1 || id(r["updated_by"].(map[string]any)) != aliceID {
		t.Fatalf("revision after the plan: %v", r)
	}
	rev++

	// The same plan again (the trip's fields too) changes nothing: no new revision.
	same := e.must(200, "PUT", base+"/plan", alice, map[string]any{"base_revision": rev,
		"trip": map[string]any{"title": "杭州两日·改", "days": 2, "travel_mode": "auto"}, "waypoints": []any{
			map[string]any{"id": b, "note": "先吃饭"}, map[string]any{"id": a}, map[string]any{"id": n1}, map[string]any{"id": l1}}}).obj(t)
	if int64(num(same["trip"].(map[string]any)["revision"])) != rev || len(same["deleted"].([]any)) != 0 {
		t.Fatalf("unchanged plan: %v", same)
	}

	// Bob changes the trip meanwhile: alice's draft (of rev) is refused.
	e.must(200, "PATCH", fmt.Sprintf("/waypoints/%d", a), bob, map[string]any{"note": "bob 的备注"})
	draft := map[string]any{"base_revision": rev, "waypoints": []any{
		map[string]any{"id": a, "note": "alice 的备注"}, map[string]any{"id": b}, map[string]any{"id": n1}, map[string]any{"id": l1}}}
	conflict := e.must(409, "PUT", base+"/plan", alice, draft).obj(t)
	if er := conflict["error"].(map[string]any); er["code"] != "conflict" || er["message"] != "行程已被 bob 修改" ||
		int64(num(conflict["revision"])) != rev+1 || id(conflict["updated_by"].(map[string]any)) != bobID || conflict["updated_at"] == "" {
		t.Fatalf("conflict: %v", conflict)
	}
	trip = get()
	if waypointOf(trip, a)["note"] != "bob 的备注" || !slices.Equal(planOf(trip), []int64{b, a, n1, l1}) {
		t.Fatalf("a refused draft changed the trip: %v", trip["waypoints"])
	}
	// Own change from another tab.
	e.must(200, "PATCH", fmt.Sprintf("/waypoints/%d", b), alice, map[string]any{"note": "另一个页面"})
	if m := e.must(409, "PUT", base+"/plan", alice, draft).obj(t)["error"].(map[string]any)["message"]; m != "行程已在你的其他页面或设备上修改" {
		t.Fatalf("own conflict message: %v", m)
	}
	// Forced: the draft overwrites (the order too).
	draft["force"] = true
	forced := e.must(200, "PUT", base+"/plan", alice, draft).obj(t)["trip"].(map[string]any)
	if waypointOf(forced, a)["note"] != "alice 的备注" || int64(num(forced["revision"])) != rev+3 ||
		!slices.Equal(planOf(forced), []int64{a, b, n1, l1}) {
		t.Fatalf("forced plan: revision %v, %v", forced["revision"], forced["waypoints"])
	}
	rev = int64(num(forced["revision"]))

	// History is never deleted: a visited stop and one with a photo left out
	// are kept; an unplanned check-in stays after the stop it followed; a
	// plan never changes check-ins (status in items is ignored).
	e.must(200, "POST", base+"/checkin", bob, map[string]any{"waypoint_id": a, "arrived_at": "2026-05-01T09:00:00+08:00"})
	extra := id(e.must(200, "POST", base+"/checkin", bob, map[string]any{"lng": 120.2000, "lat": 30.3000, "name": "小面馆",
		"arrived_at": "2026-05-01T10:00:00+08:00"}).obj(t)["waypoint"].(map[string]any))
	if r := e.upload(base+"/photos", alice, testJPEG(t, 64, 48), map[string]string{"waypoint_id": fmt.Sprint(n1)}); r.status != 200 {
		t.Fatalf("upload: %d %s", r.status, r.body)
	}
	trip = get()
	rev = int64(num(trip["revision"]))
	if !slices.Equal(planOf(trip), []int64{a, extra, b, n1, l1}) {
		t.Fatalf("order before: %v", planOf(trip))
	}
	res = e.must(200, "PUT", base+"/plan", alice, map[string]any{"base_revision": rev, "waypoints": []any{
		map[string]any{"id": l1}, map[string]any{"id": b, "status": "visited", "arrived_at": "2026-05-01T11:00:00+08:00"}}}).obj(t)
	trip = res["trip"].(map[string]any)
	if !slices.Equal(ids(t, res["kept"]), []int64{a, n1}) || len(res["deleted"].([]any)) != 0 {
		t.Fatalf("kept %v, deleted %v", res["kept"], res["deleted"])
	}
	// a is kept at the start (it was), the unplanned check-in after it, n1 after b.
	if got := planOf(trip); !slices.Equal(got, []int64{a, extra, l1, b, n1}) {
		t.Fatalf("order with kept waypoints: %v", got)
	}
	if w := waypointOf(trip, b); w["status"] != "todo" || w["arrived_at"] != nil {
		t.Fatalf("a plan changed a check-in: %v", w)
	}
	if w := waypointOf(trip, a); w["status"] != "visited" || w["arrived_at"] == nil {
		t.Fatalf("kept visit: %v", w)
	}
	rev = int64(num(trip["revision"]))

	// Lodging: one per night within the trip's days; nights can be swapped;
	// kept lodging (history) on a night that gets another hotel becomes a stop.
	l2 := id(e.must(200, "POST", base+"/lodging", alice, map[string]any{"day": 2, "name": "西溪酒店", "lng": 120.0750, "lat": 30.2750}).arr(t)[0].(map[string]any))
	rev++
	current := []any{map[string]any{"id": a}, map[string]any{"id": extra}, map[string]any{"id": l1}, map[string]any{"id": b},
		map[string]any{"id": n1}, map[string]any{"id": l2}}
	with := func(extra ...any) []any { return append(slices.Clone(current), extra...) }
	twice := e.must(409, "PUT", base+"/plan", alice, map[string]any{"base_revision": rev, "waypoints": with(
		map[string]any{"client_key": "h", "kind": "lodging", "day": 2, "name": "又一家", "lng": 120.2, "lat": 30.3})}).obj(t)
	if num(twice["index"]) != 6 || twice["error"].(map[string]any)["message"] != "第 7 项：第 2 天晚上已有住宿（第 6 项）" {
		t.Fatalf("two lodgings for a night: %v", twice)
	}
	late := e.must(400, "PUT", base+"/plan", alice, map[string]any{"base_revision": rev, "waypoints": with(
		map[string]any{"client_key": "h", "kind": "lodging", "day": 3, "name": "太晚", "lng": 120.2, "lat": 30.3})}).obj(t)
	if num(late["index"]) != 6 {
		t.Fatalf("lodging beyond the days: %v", late)
	}
	swapped := e.must(200, "PUT", base+"/plan", alice, map[string]any{"base_revision": rev, "waypoints": []any{
		map[string]any{"id": a}, map[string]any{"id": extra}, map[string]any{"id": l1, "day": 2}, map[string]any{"id": b},
		map[string]any{"id": n1}, map[string]any{"id": l2, "day": 1}}}).obj(t)["trip"].(map[string]any)
	if num(waypointOf(swapped, l1)["day"]) != 2 || num(waypointOf(swapped, l2)["day"]) != 1 || waypointOf(swapped, l2)["kind"] != "lodging" {
		t.Fatalf("swapped nights: %v / %v", waypointOf(swapped, l1), waypointOf(swapped, l2))
	}
	rev = int64(num(swapped["revision"]))
	e.must(200, "POST", base+"/checkin", bob, map[string]any{"waypoint_id": l2})
	rev++
	res = e.must(200, "PUT", base+"/plan", alice, map[string]any{"base_revision": rev, "waypoints": []any{
		map[string]any{"id": a}, map[string]any{"id": extra}, map[string]any{"id": l1}, map[string]any{"id": b}, map[string]any{"id": n1},
		map[string]any{"client_key": "h2", "kind": "lodging", "day": 1, "name": "换一家", "lng": 120.2100, "lat": 30.2900}}}).obj(t)
	trip = res["trip"].(map[string]any)
	h2 := int64(num(res["id_map"].(map[string]any)["h2"]))
	if w := waypointOf(trip, l2); !slices.Equal(ids(t, res["kept"]), []int64{l2}) || w["kind"] != "stop" || w["status"] != "visited" ||
		waypointOf(trip, h2)["kind"] != "lodging" || num(waypointOf(trip, h2)["day"]) != 1 {
		t.Fatalf("kept lodging giving way: kept %v, old %v, new %v", res["kept"], w, waypointOf(trip, h2))
	}
	rev = int64(num(trip["revision"]))

	// A waypoint deleted meanwhile: refused, or created again when forced.
	full := func(w int64) map[string]any {
		m := waypointOf(trip, w)
		return map[string]any{"id": w, "client_key": fmt.Sprint(w), "name": m["name"], "lng": m["lng"], "lat": m["lat"], "day": m["day"],
			"kind": m["kind"], "category": m["category"], "note": m["note"]}
	}
	draft = map[string]any{"base_revision": rev, "waypoints": []any{full(a), full(extra), full(l1), full(b), full(n1), full(l2), full(h2)}}
	e.must(204, "DELETE", fmt.Sprintf("%s/waypoints/%d", base, b), bob, nil)
	e.must(409, "PUT", base+"/plan", alice, draft)
	draft["force"] = true
	res = e.must(200, "PUT", base+"/plan", alice, draft).obj(t)
	again := int64(num(res["id_map"].(map[string]any)[fmt.Sprint(b)]))
	if w := waypointOf(res["trip"].(map[string]any), again); again == b || w == nil || w["name"] != "楼外楼" || w["planned"] != true {
		t.Fatalf("recreated waypoint %d: %v", again, w)
	}
}

// ids reads a JSON array of IDs.
func ids(t *testing.T, v any) []int64 {
	t.Helper()
	arr, ok := v.([]any)
	if !ok {
		t.Fatalf("not an array: %v", v)
	}
	out := []int64{}
	for _, x := range arr {
		out = append(out, int64(num(x)))
	}
	return out
}

// Deleting is idempotent: a second tap (or a waypoint another member
// deleted) is no error.
func TestIdempotentDeletes(t *testing.T) {
	e := setup(t)
	alice, _, _ := e.register("alice")
	carol, _, _ := e.register("carol")
	tid := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "删除"}).obj(t))
	other := id(e.must(200, "POST", "/trips", carol, map[string]any{"title": "别人的"}).obj(t))
	add := func(trip int64, token string) int64 {
		return id(e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints", trip), token, map[string]any{"name": "某地", "lng": 120.15, "lat": 30.26}).obj(t))
	}
	w1, w2, foreign := add(tid, alice), add(tid, alice), add(other, carol)
	rev := int64(num(e.revisionOf(tid, alice)["revision"]))
	path := func(w int64) string { return fmt.Sprintf("/trips/%d/waypoints/%d", tid, w) }

	// Two taps at once: both succeed, one revision.
	codes := make([]int, 2)
	parallel(2, func(i int) { codes[i] = e.status("DELETE", path(w1), alice, nil) })
	if codes[0] != 204 || codes[1] != 204 {
		t.Fatalf("double delete: %v", codes)
	}
	if r := e.req("DELETE", path(w1), alice, nil); r.status != 204 || len(r.body) != 0 {
		t.Fatalf("third delete: %d %q", r.status, r.body)
	}
	if got := int64(num(e.revisionOf(tid, alice)["revision"])); got != rev+1 {
		t.Fatalf("revision %d, want %d", got, rev+1)
	}
	// Only members; a waypoint of another trip is not touched.
	e.must(404, "DELETE", path(w2), carol, nil)
	e.must(401, "DELETE", path(w2), "", nil)
	e.must(204, "DELETE", path(foreign), alice, nil)
	if len(e.must(200, "GET", fmt.Sprintf("/trips/%d", other), carol, nil).obj(t)["waypoints"].([]any)) != 1 {
		t.Fatal("a waypoint of another trip was deleted")
	}
	// The old route: {} for a waypoint that is gone, still 404 for one the caller cannot see.
	e.must(200, "DELETE", fmt.Sprintf("/waypoints/%d", w2), alice, nil)
	e.must(200, "DELETE", fmt.Sprintf("/waypoints/%d", w2), alice, nil)
	e.must(200, "DELETE", "/waypoints/999999", alice, nil)
	e.must(404, "DELETE", fmt.Sprintf("/waypoints/%d", foreign), alice, nil)
	// Comments: deleting a deleted comment answers {} to whoever may delete it.
	e.must(200, "PATCH", fmt.Sprintf("/trips/%d", other), carol, map[string]any{"visibility": "public"})
	cm := id(e.must(200, "POST", fmt.Sprintf("/trips/%d/comments", other), alice, map[string]any{"content": "路过"}).obj(t))
	e.must(403, "DELETE", fmt.Sprintf("/comments/%d", cm), e.mustRegister("dave"), nil)
	e.must(200, "DELETE", fmt.Sprintf("/comments/%d", cm), alice, nil)
	e.must(200, "DELETE", fmt.Sprintf("/comments/%d", cm), alice, nil)
	e.must(200, "DELETE", fmt.Sprintf("/comments/%d", cm), carol, nil) // the trip's author
	e.must(404, "DELETE", "/comments/999999", alice, nil)
}

// mustRegister registers a user and returns the access token.
func (e *env) mustRegister(username string) string {
	tok, _, _ := e.register(username)
	return tok
}

// Two drafts of the same revision saved at once: one is saved, the other
// refused. A plan may change the trip's days: the lodging of nights cut
// then moves as with PATCH /trips/:id; members other than the owner cannot
// change the owner's settings through it; unplanned check-ins listed in a
// plan are updated and stay unplanned.
func TestSavePlanConcurrencyAndDays(t *testing.T) {
	e := setup(t)
	alice, _, _ := e.register("alice")
	bob, _, _ := e.register("bob")
	tid := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "三天", "days": 3}).obj(t))
	base := fmt.Sprintf("/trips/%d", tid)
	e.must(200, "POST", base+"/members", alice, map[string]any{"username": "bob"})
	e.must(200, "POST", base+"/members/accept", bob, nil)
	wps := e.must(200, "POST", base+"/waypoints/batch", alice, map[string]any{"items": []any{
		map[string]any{"name": "断桥残雪", "lng": 120.1513, "lat": 30.2610, "day": 1},
		map[string]any{"name": "灵隐寺", "lng": 120.1016, "lat": 30.2408, "day": 2},
		map[string]any{"name": "西溪湿地", "lng": 120.0700, "lat": 30.2700, "day": 3},
	}}).arr(t)
	s1, s2, s3 := id(wps[0].(map[string]any)), id(wps[1].(map[string]any)), id(wps[2].(map[string]any))
	n2 := id(e.must(200, "POST", base+"/lodging", alice, map[string]any{"day": 2, "name": "西溪酒店", "lng": 120.0750, "lat": 30.2750}).arr(t)[0].(map[string]any))
	rev := int64(num(e.must(200, "GET", base, alice, nil).obj(t)["revision"]))

	codes := make([]int, 2)
	parallel(2, func(i int) {
		codes[i] = e.status("PUT", base+"/plan", []string{alice, bob}[i], map[string]any{"base_revision": rev, "waypoints": []any{
			map[string]any{"id": s1, "note": fmt.Sprint("草稿 ", i)}, map[string]any{"id": s2}, map[string]any{"id": n2}, map[string]any{"id": s3}}})
	})
	if slices.Sort(codes); codes[0] != 200 || codes[1] != 409 {
		t.Fatalf("concurrent drafts: %v", codes)
	}
	rev++
	if r := e.revisionOf(tid, alice); int64(num(r["revision"])) != rev {
		t.Fatalf("revision after concurrent drafts: %v", r["revision"])
	}

	e.must(403, "PUT", base+"/plan", bob, map[string]any{"base_revision": rev, "trip": map[string]any{"visibility": "public"},
		"waypoints": []any{}})

	// Two days instead of three: day 3 goes to 未分天, the lodging of night 2
	// (after the last day) stays; one revision for all of it.
	res := e.must(200, "PUT", base+"/plan", bob, map[string]any{"base_revision": rev, "trip": map[string]any{"days": 2},
		"waypoints": []any{map[string]any{"id": s1}, map[string]any{"id": s2}, map[string]any{"id": n2}, map[string]any{"id": s3}}}).obj(t)
	trip := res["trip"].(map[string]any)
	if num(trip["days"]) != 2 || int64(num(trip["revision"])) != rev+1 || num(waypointOf(trip, s3)["day"]) != 0 ||
		waypointOf(trip, n2)["kind"] != "lodging" {
		t.Fatalf("fewer days: days %v, revision %v, %v", trip["days"], trip["revision"], trip["waypoints"])
	}
	rev++

	// An unplanned check-in listed in the plan: its note changes, it stays unplanned.
	e.must(200, "PATCH", base, alice, map[string]any{"phase": "ongoing"})
	extra := id(e.must(200, "POST", base+"/checkin", alice, map[string]any{"lng": 120.2000, "lat": 30.3000, "name": "小面馆"}).obj(t)["waypoint"].(map[string]any))
	rev += 2
	trip = e.must(200, "PUT", base+"/plan", alice, map[string]any{"base_revision": rev, "waypoints": []any{
		map[string]any{"id": s1}, map[string]any{"id": extra, "note": "很好吃", "planned": true}, map[string]any{"id": s2},
		map[string]any{"id": n2}, map[string]any{"id": s3}}}).obj(t)["trip"].(map[string]any)
	if w := waypointOf(trip, extra); w["note"] != "很好吃" || w["planned"] != false || w["status"] != "visited" ||
		!slices.Equal(planOf(trip), []int64{s1, extra, s2, n2, s3}) {
		t.Fatalf("unplanned waypoint in a plan: %v, order %v", w, planOf(trip))
	}
}

// Sending a trip's fields back unchanged (a whole form, a plan's trip) is no
// change; any field tripInput sets to another value is one.
func TestTripFieldsChanged(t *testing.T) {
	start := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(0, 0, 2)
	cur := model.Trip{Title: "杭州", Summary: "简介", Content: "正文", CoverURL: "/uploads/a.jpg", Phase: model.PhasePlanning,
		Visibility: model.VisPrivate, Status: model.TripNormal, StartDate: &start, EndDate: &end, PlanDays: 3,
		TravelMode: model.TravelAuto, Tags: []string{"美食"}, LiveShare: false}
	str := func(s string) *string { return &s }
	same := tripInput{Title: str("杭州"), Summary: str("简介"), Content: str("正文"), CoverURL: str("/uploads/a.jpg"),
		Phase: str(model.PhasePlanning), Visibility: str(model.VisPrivate), StartDate: Opt[string]{Set: true, V: "2026-05-01"},
		EndDate: Opt[string]{Set: true, V: "2026-05-03"}, Days: Opt[int]{Set: true, V: 3}, TravelMode: str(model.TravelAuto),
		Tags: &[]string{"#美食"}, LiveShare: new(bool)}
	after := cur
	if _, err := same.apply(&after, false); err != nil {
		t.Fatal(err)
	}
	if tripFieldsChanged(&cur, &after) {
		t.Fatalf("unchanged values count as a change: %+v", after)
	}
	on := true
	for name, in := range map[string]tripInput{
		"title": {Title: str("西湖")}, "summary": {Summary: str("")}, "content": {Content: str("新正文")},
		"cover": {CoverURL: str("")}, "phase": {Phase: str(model.PhaseOngoing)}, "visibility": {Visibility: str(model.VisPublic)},
		"start": {StartDate: Opt[string]{Set: true, V: "2026-04-30"}}, "end": {EndDate: Opt[string]{Set: true, Null: true}},
		"days": {Days: Opt[int]{Set: true, V: 4}}, "mode": {TravelMode: str("walking")}, "tags": {Tags: &[]string{"美食", "拍照"}},
		"live": {LiveShare: &on},
	} {
		after := cur
		if _, err := in.apply(&after, false); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !tripFieldsChanged(&cur, &after) {
			t.Errorf("changing %s is no change", name)
		}
	}
	after = cur
	after.Status = model.TripPending
	if !tripFieldsChanged(&cur, &after) {
		t.Error("a status change is no change")
	}
}

// A plan may list all of a trip's waypoints, however many there are (a
// trip with thousands of check-ins from photos is still saved); only the
// waypoints one save creates are bounded.
func TestSavePlanManyWaypoints(t *testing.T) {
	e := setup(t)
	alice, _, aliceID := e.register("alice")
	tid := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "很多照片", "days": 1}).obj(t))
	base := fmt.Sprintf("/trips/%d", tid)
	wps := make([]model.Waypoint, maxPlanWaypoints+5)
	for i := range wps {
		wps[i] = model.Waypoint{TripID: tid, Seq: i, Day: 1, Kind: model.KindStop, Planned: i%2 == 0, Status: model.WPVisited,
			Name: fmt.Sprintf("点%d", i), Lng: 120.1 + float64(i)*1e-4, Lat: 30.2, Category: "other", CreatedByID: aliceID}
	}
	if err := e.svc.DB.CreateInBatches(&wps, 500).Error; err != nil {
		t.Fatal(err)
	}
	rev := num(e.must(200, "GET", base, alice, nil).obj(t)["revision"])
	items := make([]any, 0, len(wps)+1)
	for _, w := range wps {
		items = append(items, map[string]any{"id": w.ID})
	}
	items = append(items, map[string]any{"client_key": "tmp1", "name": "新的", "lng": 120.3, "lat": 30.3, "day": 1})
	res := e.must(200, "PUT", base+"/plan", alice, map[string]any{"base_revision": rev, "waypoints": items}).obj(t)
	if trip := res["trip"].(map[string]any); len(trip["waypoints"].([]any)) != len(wps)+1 || num(res["id_map"].(map[string]any)["tmp1"]) == 0 {
		t.Fatalf("saved %d waypoints", len(trip["waypoints"].([]any)))
	}
	many := make([]any, maxPlanWaypoints+1)
	for i := range many {
		many[i] = map[string]any{"name": fmt.Sprint("新", i), "lng": 120.2, "lat": 30.2, "day": 1}
	}
	rev = num(e.must(200, "GET", base, alice, nil).obj(t)["revision"])
	if r := e.req("PUT", base+"/plan", alice, map[string]any{"base_revision": rev, "waypoints": many}); r.status != 400 ||
		!strings.Contains(string(r.body), "单次最多新增") {
		t.Fatalf("too many new waypoints: %d %s", r.status, r.body)
	}
}
