package handler

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"

	"triphub/internal/amap"
)

// Endpoints and fields the web client relies on (see web/src/api).

func TestGeoAround(t *testing.T) {
	e := setup(t)
	tok, _, _ := e.register("walker")
	path := "/geo/around?lng=120.1500&lat=30.2600&radius=300"
	e.must(401, "GET", path, "", nil)
	// No AMap key: nothing to list, not an error.
	if r := e.must(200, "GET", path, tok, nil).obj(t); r["source"] != "none" || len(r["items"].([]any)) != 0 {
		t.Fatalf("around without AMap: %v", r)
	}
	e.must(400, "GET", "/geo/around?radius=300", tok, nil)

	var keyword string
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v3/place/around" {
			_, _ = w.Write([]byte(`{"status":"1","count":"0","infocode":"10000","pois":[]}`))
			return
		}
		mu.Lock()
		keyword = r.URL.Query().Get("keywords")
		mu.Unlock()
		if r.URL.Query().Get("location") == "121.000000,31.000000" {
			_, _ = w.Write([]byte(`{"status":"0","info":"DAILY_QUERY_OVER_LIMIT","infocode":"10003"}`))
			return
		}
		// Not sorted, and AMap's distances are from its snapped point.
		_, _ = w.Write([]byte(`{"status":"1","count":"2","infocode":"10000","pois":[
			{"id":"B0FAR00001","name":"远一点的茶馆","type":"餐饮服务;茶艺馆","address":"北山街2号","location":"120.152000,30.260000",
			 "pname":"浙江省","cityname":"杭州市","adname":"西湖区","distance":"1"},
			{"id":"B0NEAR0001","name":"湖边小店","type":"购物服务;便民商店","address":"北山街1号","location":"120.150100,30.260000",
			 "pname":"浙江省","cityname":"杭州市","adname":"西湖区","distance":"999"}]}`))
	}))
	t.Cleanup(srv.Close)
	am := amap.New("test-key")
	am.SetBaseURL(srv.URL)
	e.svc.Amap = am

	r := e.must(200, "GET", path+"&keyword="+url.QueryEscape("小店"), tok, nil).obj(t)
	got := r["items"].([]any)
	if r["source"] != "amap" || len(got) != 2 {
		t.Fatalf("around: %v", r)
	}
	near, far := got[0].(map[string]any), got[1].(map[string]any)
	if near["amap_id"] != "B0NEAR0001" || near["name"] != "湖边小店" || near["city"] != "杭州市" || near["category"] == "" ||
		num(near["distance_m"]) < 5 || num(near["distance_m"]) > 15 || far["amap_id"] != "B0FAR00001" ||
		num(far["distance_m"]) < 180 || num(far["distance_m"]) > 210 {
		t.Fatalf("around items (nearest first, distance from the request): %v", got)
	}
	if _, ok := near["place"]; !ok {
		t.Fatalf("around items carry place stats like /geo/search: %v", near)
	}
	mu.Lock()
	kw := keyword
	mu.Unlock()
	if kw != "小店" {
		t.Fatalf("keyword not passed to AMap: %q", kw)
	}
	// AMap failing is reported, so the client can say the list is unavailable.
	e.must(500, "GET", "/geo/around?lng=121&lat=31", tok, nil)
}

func TestTripInviteNotification(t *testing.T) {
	e := setup(t)
	alice, _, _ := e.register("alice")
	bob, _, _ := e.register("bob")
	trip := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "一起去杭州"}).obj(t))
	e.must(200, "POST", fmt.Sprintf("/trips/%d/members", trip), alice, map[string]any{"username": "bob"})
	invite := func() map[string]any {
		t.Helper()
		for _, it := range items(t, e.must(200, "GET", "/notifications", bob, nil)) {
			if n := it.(map[string]any); n["type"] == "trip_invite" {
				return n
			}
		}
		t.Fatal("no trip_invite notification")
		return nil
	}
	if n := invite(); n["invite_pending"] != true || n["trip"] == nil {
		t.Fatalf("pending invite: %v", n)
	}
	e.must(200, "POST", fmt.Sprintf("/trips/%d/members/accept", trip), bob, nil)
	if n := invite(); n["invite_pending"] != false {
		t.Fatalf("answered invite: %v", n)
	}
}

func TestCheckinClientID(t *testing.T) {
	e := setup(t)
	tok, _, _ := e.register("traveler")
	trip := id(e.must(200, "POST", "/trips", tok, map[string]any{"title": "西湖", "phase": "ongoing"}).obj(t))
	plan := id(e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints", trip), tok, map[string]any{
		"name": "断桥残雪", "lng": 120.1513, "lat": 30.2610, "planned": true}).obj(t))
	count := func() int {
		t.Helper()
		return len(e.must(200, "GET", fmt.Sprintf("/trips/%d", trip), tok, nil).obj(t)["waypoints"].([]any))
	}
	// About 150 m from the planned stop: it is reached. Re-sending the same
	// check-in (the response was lost) must not add a stop there.
	body := map[string]any{"lng": 120.1528, "lat": 30.2610, "arrived_at": "2026-05-01T10:00:00+08:00", "client_id": "c0ffee-1"}
	first := e.must(200, "POST", fmt.Sprintf("/trips/%d/checkin", trip), tok, body).obj(t)
	if id(first["waypoint"].(map[string]any)) != plan || first["matched_plan"] != true || first["duplicate"] != false {
		t.Fatalf("first check-in: %v", first)
	}
	again := e.must(200, "POST", fmt.Sprintf("/trips/%d/checkin", trip), tok, body).obj(t)
	if id(again["waypoint"].(map[string]any)) != plan || again["matched_plan"] != true || again["duplicate"] != true || count() != 1 {
		t.Fatalf("re-sent check-in: %v (%d waypoints)", again, count())
	}
	// An unplanned check-in, re-sent.
	body = map[string]any{"lng": 120.1700, "lat": 30.2700, "name": "小面馆", "arrived_at": "2026-05-01T12:00:00+08:00", "client_id": "c0ffee-2"}
	extra := e.must(200, "POST", fmt.Sprintf("/trips/%d/checkin", trip), tok, body).obj(t)
	again = e.must(200, "POST", fmt.Sprintf("/trips/%d/checkin", trip), tok, body).obj(t)
	if id(again["waypoint"].(map[string]any)) != id(extra["waypoint"].(map[string]any)) || again["duplicate"] != true ||
		again["matched_plan"] != false || count() != 2 {
		t.Fatalf("re-sent unplanned check-in: %v (%d waypoints)", again, count())
	}
	e.must(400, "POST", fmt.Sprintf("/trips/%d/checkin", trip), tok, map[string]any{"lng": 120.18, "lat": 30.28, "client_id": "有空格 的键"})
}

func TestPhotoClientID(t *testing.T) {
	e := setup(t)
	tok, _, _ := e.register("snapper")
	trip := id(e.must(200, "POST", "/trips", tok, map[string]any{"title": "拍照", "phase": "ongoing"}).obj(t))
	img := testJPEG(t, 64, 48)
	fields := map[string]string{"lng": "120.15", "lat": "30.26", "taken_at": "2026-05-01T10:00:00+08:00",
		"auto_waypoint": "true", "client_id": "photo-1"}
	path := fmt.Sprintf("/trips/%d/photos", trip)
	first := e.upload(path, tok, img, fields)
	if first.status != 200 {
		t.Fatalf("upload: %d %s", first.status, first.body)
	}
	f := first.obj(t)
	if f["duplicate"] != false || f["waypoint_created"] != true {
		t.Fatalf("first upload: %v", f)
	}
	used := num(e.must(200, "GET", "/me", tok, nil).obj(t)["storage_used"])
	photos := func() int {
		t.Helper()
		return len(e.must(200, "GET", fmt.Sprintf("/trips/%d", trip), tok, nil).obj(t)["photos"].([]any))
	}
	// Re-sent after a lost response: the stored photo, charged once.
	r := e.upload(path, tok, img, fields)
	if r.status != 200 {
		t.Fatalf("re-sent upload: %d %s", r.status, r.body)
	}
	m := r.obj(t)
	if id(m["photo"].(map[string]any)) != id(f["photo"].(map[string]any)) || m["duplicate"] != true || m["waypoint_created"] != false ||
		m["waypoint"] == nil || id(m["waypoint"].(map[string]any)) != id(f["waypoint"].(map[string]any)) {
		t.Fatalf("re-sent upload: %v, first %v", m, f)
	}
	if n := photos(); n != 1 {
		t.Fatalf("%d photos stored", n)
	}
	if now := num(e.must(200, "GET", "/me", tok, nil).obj(t)["storage_used"]); now != used {
		t.Fatalf("storage charged again: %v, then %v", used, now)
	}
	// Another photo sent by several tabs at once: stored once.
	fields["client_id"] = "photo-2"
	var wg sync.WaitGroup
	res := make([]resp, 4)
	for i := range res {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			res[i] = e.upload(path, tok, img, fields)
		}(i)
	}
	wg.Wait()
	stored, dups := int64(0), 0
	for _, r := range res {
		if r.status != 200 {
			t.Fatalf("concurrent upload: %d %s", r.status, r.body)
		}
		m := r.obj(t)
		pid := id(m["photo"].(map[string]any))
		if stored == 0 {
			stored = pid
		}
		if pid != stored {
			t.Fatalf("concurrent uploads stored different photos: %v", res)
		}
		if m["duplicate"] == true {
			dups++
		}
	}
	if dups != len(res)-1 || photos() != 2 {
		t.Fatalf("concurrent uploads: %d duplicates, %d photos", dups, photos())
	}
}

func TestSiteMapAttribution(t *testing.T) {
	e := setup(t)
	e.svc.Cfg.TilesAttribution = "© 高德地图 GS(2024)1234号"
	m := e.must(200, "GET", "/site", "", nil).obj(t)["map"].(map[string]any)
	if m["attribution"] != "© 高德地图 GS(2024)1234号" || m["tiles"] == nil {
		t.Fatalf("site map: %v", m)
	}
}

func TestCoverThumbURL(t *testing.T) {
	e := setup(t)
	tok, _, _ := e.register("cover")
	trip := id(e.must(200, "POST", "/trips", tok, map[string]any{"title": "封面", "visibility": "public", "phase": "finished"}).obj(t))
	wp := id(e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints", trip), tok, map[string]any{
		"name": "湖边小店", "lng": 120.15, "lat": 30.26, "planned": false, "status": "visited", "verdict": "recommend"}).obj(t))
	up := e.upload(fmt.Sprintf("/trips/%d/photos", trip), tok, testJPEG(t, 640, 480), map[string]string{"waypoint_id": fmt.Sprint(wp)})
	if up.status != 200 {
		t.Fatalf("upload: %d %s", up.status, up.body)
	}
	photo := up.obj(t)["photo"].(map[string]any)
	full, thumb := photo["url"].(string), photo["thumb_url"].(string)
	card := items(t, e.must(200, "GET", "/me/trips", tok, nil))[0].(map[string]any)
	if card["cover_url"] != full || card["cover_thumb_url"] != thumb {
		t.Fatalf("trip card cover: %v / %v, photo %s / %s", card["cover_url"], card["cover_thumb_url"], full, thumb)
	}
	fp := e.must(200, "GET", "/me/footprints", tok, nil).obj(t)["trips"].([]any)[0].(map[string]any)
	if fp["cover_url"] != full || fp["cover_thumb_url"] != thumb {
		t.Fatalf("footprint trip cover: %v", fp)
	}
	pid := int64(num(e.must(200, "GET", fmt.Sprintf("/trips/%d", trip), tok, nil).obj(t)["waypoints"].([]any)[0].(map[string]any)["place_id"]))
	place := e.must(200, "GET", fmt.Sprintf("/places/%d", pid), "", nil).obj(t)
	if place["cover_url"] != full || place["cover_thumb_url"] != thumb {
		t.Fatalf("place cover: %v / %v", place["cover_url"], place["cover_thumb_url"])
	}
	// A cover without a separate thumbnail (here: the thumbnail itself) is its own thumbnail.
	d := e.must(200, "PATCH", fmt.Sprintf("/trips/%d", trip), tok, map[string]any{"cover_url": thumb}).obj(t)
	if d["cover_url"] != thumb || d["cover_thumb_url"] != thumb {
		t.Fatalf("custom cover: %v / %v", d["cover_url"], d["cover_thumb_url"])
	}
}
