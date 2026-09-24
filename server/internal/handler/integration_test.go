package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"log/slog"
	"math"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"triphub/internal/ai"
	"triphub/internal/amap"
	"triphub/internal/config"
	"triphub/internal/db"
	"triphub/internal/geo"
	"triphub/internal/media"
	"triphub/internal/service"
)

// The integration test needs a real Postgres. It DROPS the public schema of
// the target database, so point it at a dedicated test database:
//
//	TRIPHUB_TEST_DSN=postgres://triphub:triphub@localhost:5432/triphub_test?sslmode=disable go test ./...

type env struct {
	t    *testing.T
	base string
	data string
	svc  *service.Service
}

type resp struct {
	status int
	body   []byte
}

func (r resp) obj(t *testing.T) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(r.body, &m); err != nil {
		t.Fatalf("decode object: %v: %s", err, r.body)
	}
	return m
}

func (r resp) arr(t *testing.T) []any {
	t.Helper()
	var a []any
	if err := json.Unmarshal(r.body, &a); err != nil {
		t.Fatalf("decode array: %v: %s", err, r.body)
	}
	return a
}

func (e *env) req(method, path, token string, body any) resp {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	r, _ := http.NewRequest(method, e.base+path, rd)
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		e.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	return resp{res.StatusCode, data}
}

// must performs a request and asserts the status code.
func (e *env) must(want int, method, path, token string, body any) resp {
	e.t.Helper()
	r := e.req(method, path, token, body)
	if r.status != want {
		e.t.Fatalf("%s %s: status %d, want %d: %s", method, path, r.status, want, r.body)
	}
	return r
}

func (e *env) upload(path, token string, img []byte, fields map[string]string) resp {
	e.t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range fields {
		_ = mw.WriteField(k, v)
	}
	fw, _ := mw.CreateFormFile("file", "photo.jpg")
	_, _ = fw.Write(img)
	_ = mw.Close()
	r, _ := http.NewRequest(http.MethodPost, e.base+path, &buf)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	r.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	return resp{res.StatusCode, data}
}

func num(v any) float64 {
	f, _ := v.(float64)
	return f
}

func id(m map[string]any) int64 { return int64(num(m["id"])) }

func items(t *testing.T, r resp) []any {
	t.Helper()
	m := r.obj(t)
	it, ok := m["items"].([]any)
	if !ok {
		t.Fatalf("no items: %s", r.body)
	}
	return it
}

func testJPEG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y += 4 {
		for x := 0; x < w; x += 4 {
			c := color.RGBA{uint8(x * 255 / w), uint8(y * 255 / h), 120, 255}
			for dy := 0; dy < 4 && y+dy < h; dy++ {
				for dx := 0; dx < 4 && x+dx < w; dx++ {
					img.Set(x+dx, y+dy, c)
				}
			}
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 80}); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// fakeAI answers chat completions: recommendation picks or an itinerary.
func fakeAI(t *testing.T) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		prompt := req.Messages[len(req.Messages)-1].Content
		var content string
		if strings.Contains(prompt, "候选地点") {
			content = "好的：\n```json\n{\"picks\":[{\"index\":1,\"reason\":\"顺路先去计划中的下一站\"}],\"text\":\"傍晚适合去湖边散步\",\"ideas\":[]}\n```"
		} else {
			content = `{"title":"杭州两日·湖光山色","summary":"轻松游西湖","items":[` +
				`{"day":1,"name":"断桥残雪","address":"北山街","category":"scenic","note":"清晨人少","lng":120.1513,"lat":30.2610},` +
				`{"day":1,"name":"楼外楼","category":"food","note":"西湖醋鱼","lng":999,"lat":999},` +
				`{"day":5,"name":"灵隐寺","category":"temple","note":"早去"}]}`
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": content}}}})
	}))
}

func setup(t *testing.T) *env {
	dsn := os.Getenv("TRIPHUB_TEST_DSN")
	if dsn == "" {
		t.Skip("TRIPHUB_TEST_DSN not set; skipping integration test")
	}
	if !testing.Verbose() {
		slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	}
	ctx := context.Background()
	gdb, err := db.Open(ctx, dsn, 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if err := gdb.Exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(gdb); err != nil {
		t.Fatal(err)
	}
	dataDir := t.TempDir()
	cfg := &config.Config{DataDir: dataDir, JWTSecret: "integration-test-secret-0123456789abcdef", MaxUploadMB: 20,
		SiteName: "TripHub", CORSOrigins: []string{"*"}, AITimeout: 10 * time.Second,
		TilesNormal: []string{"n"}, TilesSatellite: []string{"s"}, TilesSatelliteLabel: []string{"l"}}
	if err := cfg.Prepare(); err != nil {
		t.Fatal(err)
	}
	atlas, err := geo.DefaultAtlas()
	if err != nil {
		t.Fatal(err)
	}
	settings, err := service.LoadSettings(gdb, cfg.SiteName)
	if err != nil {
		t.Fatal(err)
	}
	aiSrv := fakeAI(t)
	t.Cleanup(aiSrv.Close)
	loc, _ := time.LoadLocation("Asia/Shanghai")
	svc := service.New(gdb, cfg, atlas, amap.New(""), ai.New(aiSrv.URL, "", "fake", 5*time.Second),
		media.NewStore(cfg.UploadDir(), 2), settings, loc)
	if _, err := svc.SeedAdmin(ctx, "root", "rootpass123"); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(New(svc, nil).Router())
	t.Cleanup(srv.Close)
	return &env{t: t, base: srv.URL + "/api/v1", data: dataDir, svc: svc}
}

func (e *env) register(username string) (token, refresh string, userID int64) {
	e.t.Helper()
	r := e.must(200, "POST", "/auth/register", "", map[string]any{"username": username, "password": "secret123", "email": username + "@example.com",
		"agree_terms": true})
	m := r.obj(e.t)
	return m["access_token"].(string), m["refresh_token"].(string), id(m["user"].(map[string]any))
}

func TestIntegration(t *testing.T) {
	e := setup(t)

	// ---- auth ----
	e.must(200, "GET", "/health", "", nil)
	site := e.must(200, "GET", "/site", "", nil).obj(t)
	if site["amap_search"] != false || site["ai_enabled"] != true || len(site["levels"].([]any)) != 6 {
		t.Fatalf("site: %v", site)
	}
	alice, _, aliceID := e.register("alice")
	bob, bobRefresh, bobID := e.register("Bob_1")
	e.must(409, "POST", "/auth/register", "", map[string]any{"username": "ALICE", "password": "secret123", "agree_terms": true})
	e.must(400, "POST", "/auth/register", "", map[string]any{"username": "a!", "password": "secret123", "agree_terms": true})
	e.must(400, "POST", "/auth/register", "", map[string]any{"username": "carol", "password": "123", "agree_terms": true})
	e.must(400, "POST", "/auth/register", "", map[string]any{"username": "carol", "password": "secret123"}) // no consent
	e.must(200, "POST", "/auth/login", "", map[string]any{"account": "bob_1", "password": "secret123"})
	e.must(200, "POST", "/auth/login", "", map[string]any{"account": "alice@example.com", "password": "secret123"})
	for i := 0; i < 5; i++ {
		e.must(401, "POST", "/auth/login", "", map[string]any{"account": "alice", "password": "wrong-password"})
	}
	e.must(429, "POST", "/auth/login", "", map[string]any{"account": "alice", "password": "secret123"})
	ref := e.must(200, "POST", "/auth/refresh", "", map[string]any{"refresh_token": bobRefresh}).obj(t)
	e.must(401, "POST", "/auth/refresh", "", map[string]any{"refresh_token": bobRefresh})
	bob = ref["access_token"].(string)
	me := e.must(200, "GET", "/me", bob, nil).obj(t)
	if me["username"] != "Bob_1" || num(me["level"]) != 1 || num(me["storage_quota"]) != 300<<20 {
		t.Fatalf("me: %v", me)
	}
	e.must(401, "GET", "/me", "", nil)
	e.must(401, "GET", "/me", "not-a-token", nil)

	// ---- trip + waypoints ----
	trip := e.must(200, "POST", "/trips", alice, map[string]any{
		"title": "杭州两日", "summary": "西湖边走走", "tags": []string{"美食", "#西湖", "美食"},
		"start_date": "2026-05-01", "end_date": "2026-05-02",
	}).obj(t)
	tripID := id(trip)
	if trip["phase"] != "planning" || trip["visibility"] != "private" || trip["share_code"] == nil || num(trip["days"]) != 2 {
		t.Fatalf("trip: %v", trip)
	}
	if tags := trip["tags"].([]any); len(tags) != 2 {
		t.Fatalf("tags not cleaned: %v", tags)
	}
	shareCode := trip["share_code"].(string)
	e.must(400, "POST", "/trips", alice, map[string]any{"title": " "})

	batch := e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints/batch", tripID), alice, map[string]any{"items": []any{
		map[string]any{"name": "断桥残雪", "lng": 120.1513, "lat": 30.2610, "category": "scenic", "day": 1},
		map[string]any{"name": "楼外楼", "lng": 120.1437, "lat": 30.2556, "category": "food", "day": 1, "amap_id": "B023B0J1V1"},
		map[string]any{"name": "雷峰塔", "lng": 120.1488, "lat": 30.2317, "category": "scenic", "day": 2},
	}}).arr(t)
	if len(batch) != 3 {
		t.Fatalf("batch: %v", batch)
	}
	w0 := batch[0].(map[string]any)
	if w0["planned"] != true || w0["status"] != "todo" || w0["province"] != "浙江省" || w0["city"] != "杭州市" || w0["place_id"] == nil {
		t.Fatalf("waypoint defaults/geo: %v", w0)
	}
	wpIDs := []int64{id(batch[0].(map[string]any)), id(batch[1].(map[string]any)), id(batch[2].(map[string]any))}
	// Insert at the front, then reorder.
	front := e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints", tripID), alice, map[string]any{
		"name": "", "lng": 120.1600, "lat": 30.2700, "seq": 0, "planned": true}).obj(t)
	if num(front["seq"]) != 0 || front["name"] == "" {
		t.Fatalf("insert at front: %v", front)
	}
	e.must(400, "PUT", fmt.Sprintf("/trips/%d/waypoints/order", tripID), alice, map[string]any{"ids": wpIDs})
	order := []int64{wpIDs[2], wpIDs[1], wpIDs[0], id(front)}
	ordered := e.must(200, "PUT", fmt.Sprintf("/trips/%d/waypoints/order", tripID), alice, map[string]any{"ids": order}).arr(t)
	for i, w := range ordered {
		if id(w.(map[string]any)) != order[i] || int(num(w.(map[string]any)["seq"])) != i {
			t.Fatalf("order mismatch at %d: %v", i, w)
		}
	}
	e.must(200, "DELETE", fmt.Sprintf("/waypoints/%d", id(front)), alice, nil)
	e.must(404, "POST", fmt.Sprintf("/trips/%d/waypoints", tripID), bob, map[string]any{"name": "x", "lng": 120, "lat": 30}) // private: invisible to bob
	// ---- visibility ----
	e.must(404, "GET", fmt.Sprintf("/trips/%d", tripID), bob, nil)
	e.must(404, "GET", "/share/"+shareCode, "", nil)
	if n := len(items(t, e.must(200, "GET", "/trips", "", nil))); n != 0 {
		t.Fatalf("private trip listed")
	}
	e.must(200, "PATCH", fmt.Sprintf("/trips/%d", tripID), alice, map[string]any{"visibility": "unlisted"})
	shared := e.must(200, "GET", "/share/"+shareCode, "", nil).obj(t)
	if shared["share_code"] != nil || len(shared["waypoints"].([]any)) != 3 {
		t.Fatalf("share view: %v", shared)
	}
	e.must(404, "GET", fmt.Sprintf("/trips/%d", tripID), bob, nil)
	e.must(200, "GET", fmt.Sprintf("/trips/%d?share_code=%s", tripID, shareCode), bob, nil)
	e.must(200, "GET", fmt.Sprintf("/trips/%d/track?share_code=%s", tripID, shareCode), "", nil)
	// live_share: guests may follow the ongoing trip (checked off and on again in the track section).
	pub := e.must(200, "PATCH", fmt.Sprintf("/trips/%d", tripID), alice, map[string]any{"visibility": "public", "phase": "ongoing", "live_share": true}).obj(t)
	if pub["published_at"] == nil || pub["phase"] != "ongoing" {
		t.Fatalf("publish: %v", pub)
	}
	list := items(t, e.must(200, "GET", "/trips?tab=latest&tag="+url.QueryEscape("美食"), "", nil))
	if len(list) != 1 || id(list[0].(map[string]any)) != tripID {
		t.Fatalf("public listing: %v", list)
	}
	if len(items(t, e.must(200, "GET", "/trips?tab=hot&q="+url.QueryEscape("杭州"), "", nil))) != 1 {
		t.Fatal("search by city failed")
	}
	if len(items(t, e.must(200, "GET", "/trips?phase=finished", "", nil))) != 0 {
		t.Fatal("phase filter failed")
	}
	e.must(401, "GET", "/trips?tab=following", "", nil)
	e.must(403, "PATCH", fmt.Sprintf("/trips/%d", tripID), bob, map[string]any{"title": "hack"})

	// ---- photo upload with auto waypoint ----
	wlng, wlat := geo.GCJ02ToWGS84(120.1300, 30.2500) // far from existing waypoints
	up := e.upload(fmt.Sprintf("/trips/%d/photos", tripID), alice, testJPEG(t, 3000, 2000), map[string]string{
		"lng": fmt.Sprint(wlng), "lat": fmt.Sprint(wlat), "taken_at": "2026-05-01T09:30:00+08:00",
		"auto_waypoint": "true", "caption": "湖边",
	})
	if up.status != 200 {
		t.Fatalf("upload: %d %s", up.status, up.body)
	}
	um := up.obj(t)
	photo := um["photo"].(map[string]any)
	if um["waypoint_created"] != true || um["waypoint"] == nil || num(photo["width"]) != 2560 || num(photo["height"]) < 1706 || num(photo["height"]) > 1707 {
		t.Fatalf("upload result: %v", um)
	}
	if d := geo.Haversine(num(photo["lng"]), num(photo["lat"]), 120.13, 30.25); d > 1 {
		t.Fatalf("photo coords not converted to GCJ-02 (off by %.1fm)", d)
	}
	autoWP := um["waypoint"].(map[string]any)
	if autoWP["planned"] != false || autoWP["status"] != "visited" || autoWP["city"] != "杭州市" {
		t.Fatalf("auto waypoint: %v", autoWP)
	}
	for _, u := range []string{photo["url"].(string), photo["thumb_url"].(string)} {
		res, err := http.Get(strings.TrimSuffix(e.base, "/api/v1") + u)
		if err != nil || res.StatusCode != 200 || res.Header.Get("Cache-Control") == "" {
			t.Fatalf("GET %s: %v %v", u, err, res)
		}
		res.Body.Close()
	}
	// A second photo nearby links to the same waypoint.
	up2 := e.upload(fmt.Sprintf("/trips/%d/photos", tripID), alice, testJPEG(t, 400, 300), map[string]string{
		"lng": fmt.Sprint(wlng + 0.0005), "lat": fmt.Sprint(wlat), "auto_waypoint": "true"}).obj(t)
	if up2["waypoint_created"] != false || id(up2["waypoint"].(map[string]any)) != id(autoWP) {
		t.Fatalf("second upload should link: %v", up2)
	}
	if bad := e.upload(fmt.Sprintf("/trips/%d/photos", tripID), alice, []byte("not an image"), nil); bad.status != 400 {
		t.Fatalf("bad image: %d", bad.status)
	}
	meA := e.must(200, "GET", "/me", alice, nil).obj(t)
	if num(meA["storage_used"]) <= 0 {
		t.Fatalf("storage not counted: %v", meA)
	}

	// ---- travel mode: check-in / skip / compare / recommend ----
	ci := e.must(200, "POST", fmt.Sprintf("/trips/%d/checkin", tripID), alice, map[string]any{"lng": 120.1514, "lat": 30.2611}).obj(t)
	if ci["matched_plan"] != true || ci["duplicate"] != false || id(ci["waypoint"].(map[string]any)) != wpIDs[0] {
		t.Fatalf("checkin should match 断桥: %v", ci)
	}
	// Tapping 我到了 again (or a retried request) returns the same stop instead of adding one.
	ci2 := e.must(200, "POST", fmt.Sprintf("/trips/%d/checkin", tripID), alice, map[string]any{"lng": 120.1514, "lat": 30.2611}).obj(t)
	if ci2["matched_plan"] != true || ci2["duplicate"] != true || id(ci2["waypoint"].(map[string]any)) != wpIDs[0] {
		t.Fatalf("repeated checkin: %v", ci2)
	}
	extra := e.must(200, "POST", fmt.Sprintf("/trips/%d/checkin", tripID), alice, map[string]any{
		"lng": 120.1700, "lat": 30.2800, "name": "路边小吃"}).obj(t)
	if extra["matched_plan"] != false || extra["waypoint"].(map[string]any)["planned"] != false {
		t.Fatalf("extra checkin: %v", extra)
	}
	e.must(200, "POST", fmt.Sprintf("/waypoints/%d/checkin", wpIDs[1]), alice, map[string]any{})
	// An explicit arrived_at also corrects an already-visited stop by waypoint_id; without one the time is kept.
	ts := time.Now().Add(time.Minute).Truncate(time.Second)
	arrived := func(r resp) time.Time {
		t.Helper()
		at, err := time.Parse(time.RFC3339, r.obj(t)["waypoint"].(map[string]any)["arrived_at"].(string))
		if err != nil {
			t.Fatal(err)
		}
		return at
	}
	byID := fmt.Sprintf("/trips/%d/checkin", tripID)
	if at := arrived(e.must(200, "POST", byID, alice, map[string]any{"waypoint_id": wpIDs[1], "arrived_at": ts.Format(time.RFC3339)})); !at.Equal(ts) {
		t.Fatalf("explicit arrived_at of a visited stop: %v, want %v", at, ts)
	}
	if at := arrived(e.must(200, "POST", byID, alice, map[string]any{"waypoint_id": wpIDs[1]})); !at.Equal(ts) {
		t.Fatalf("repeated check-in changed arrived_at: %v, want %v", at, ts)
	}
	e.must(200, "PATCH", fmt.Sprintf("/waypoints/%d", wpIDs[1]), alice, map[string]any{"verdict": "recommend", "rating": 5, "cost": 120, "note": "醋鱼不错"})
	e.must(200, "POST", fmt.Sprintf("/waypoints/%d/skip", wpIDs[2]), alice, nil)
	e.must(400, "POST", fmt.Sprintf("/waypoints/%d/skip", id(autoWP)), alice, nil)
	cmp := e.must(200, "GET", fmt.Sprintf("/trips/%d/compare", tripID), "", nil).obj(t)
	if num(cmp["completion_rate"]) < 0.66 || num(cmp["completion_rate"]) > 0.67 || len(cmp["extra"].([]any)) != 2 || len(cmp["skipped"].([]any)) != 1 {
		t.Fatalf("compare: %v", cmp)
	}
	e.must(200, "POST", fmt.Sprintf("/waypoints/%d/reset", wpIDs[2]), alice, nil)
	rec := e.must(200, "GET", fmt.Sprintf("/trips/%d/recommend?lng=120.1437&lat=30.2556", tripID), alice, nil).obj(t)
	if rec["ai_used"] != false || rec["next_planned"] == nil || len(rec["suggestions"].([]any)) == 0 {
		t.Fatalf("recommend: %v", rec)
	}
	recAI := e.must(200, "GET", fmt.Sprintf("/trips/%d/recommend?lng=120.1437&lat=30.2556&ai=true", tripID), alice, nil).obj(t)
	if recAI["ai_used"] != true || recAI["ai_text"] == nil {
		t.Fatalf("recommend with AI: %v", recAI)
	}
	e.must(403, "GET", fmt.Sprintf("/trips/%d/recommend", tripID), bob, nil)
	plan := e.must(200, "POST", "/ai/plan", bob, map[string]any{"destination": "杭州", "days": 2, "preferences": "美食"}).obj(t)
	pitems := plan["items"].([]any)
	if plan["title"] == "" || len(pitems) != 3 {
		t.Fatalf("ai plan: %v", plan)
	}
	if p0 := pitems[0].(map[string]any); p0["located"] != false || p0["lng"] == nil {
		t.Fatalf("plausible AI coordinates should be kept: %v", p0)
	}
	if p1 := pitems[1].(map[string]any); p1["place_id"] == nil {
		t.Fatalf("community place should be linked by name: %v", p1)
	}
	if p2 := pitems[2].(map[string]any); num(p2["day"]) != 2 || p2["category"] != "other" || p2["lng"] != nil {
		t.Fatalf("AI item not sanitised: %v", p2)
	}

	// ---- places ----
	places := items(t, e.must(200, "GET", "/places?q="+url.QueryEscape("楼外楼"), "", nil))
	if len(places) != 1 {
		t.Fatalf("places: %v", places)
	}
	pl := places[0].(map[string]any)
	placeID := id(pl)
	if num(pl["checkin_count"]) != 1 || num(pl["rating_avg"]) != 5 || num(pl["recommend_count"]) != 1 || num(pl["avg_cost"]) != 120 {
		t.Fatalf("place aggregates: %v", pl)
	}
	found := false // the keyword also matches the city (楼外楼 has no address)
	for _, v := range items(t, e.must(200, "GET", "/places?q="+url.QueryEscape("杭州"), "", nil)) {
		found = found || id(v.(map[string]any)) == placeID
	}
	if !found {
		t.Fatal("place search by city failed")
	}
	near := e.must(200, "GET", "/places/nearby?lng=120.1440&lat=30.2556&radius=500", "", nil).arr(t)
	if len(near) != 1 || near[0].(map[string]any)["distance_m"] == nil {
		t.Fatalf("nearby: %v", near)
	}
	// Trip details carry the community summary of their places (those with public check-ins).
	for _, w := range e.must(200, "GET", fmt.Sprintf("/trips/%d", tripID), bob, nil).obj(t)["waypoints"].([]any) {
		wm := w.(map[string]any)
		ps, _ := wm["place_stats"].(map[string]any)
		if (wm["name"] == "楼外楼" && (ps == nil || int64(num(ps["id"])) != placeID || num(ps["recommend_count"]) != 1 || num(ps["checkin_count"]) != 1)) ||
			(wm["name"] == "雷峰塔" && ps != nil) {
			t.Fatalf("place_stats of %v: %v", wm["name"], ps)
		}
	}
	reviews := items(t, e.must(200, "GET", fmt.Sprintf("/places/%d/reviews?verdict=recommend", placeID), "", nil))
	if len(reviews) != 1 {
		t.Fatalf("reviews: %v", reviews)
	}
	e.must(200, "POST", fmt.Sprintf("/places/%d/comments", placeID), bob, map[string]any{"content": "去过，确实好吃"})

	// ---- social: like / favorite / comment / reply ----
	lk := e.must(200, "POST", fmt.Sprintf("/trips/%d/like", tripID), bob, nil).obj(t)
	e.must(200, "POST", fmt.Sprintf("/trips/%d/like", tripID), bob, nil)
	if lk["liked"] != true || num(lk["like_count"]) != 1 {
		t.Fatalf("like: %v", lk)
	}
	e.must(200, "POST", fmt.Sprintf("/trips/%d/favorite", tripID), bob, nil)
	if favs := items(t, e.must(200, "GET", "/me/favorites", bob, nil)); len(favs) != 1 {
		t.Fatalf("favorites: %v", favs)
	}
	c1 := e.must(200, "POST", fmt.Sprintf("/trips/%d/comments", tripID), bob, map[string]any{"content": "排队一小时，不值", "waypoint_id": wpIDs[1]}).obj(t)
	r1 := e.must(200, "POST", fmt.Sprintf("/trips/%d/comments", tripID), alice, map[string]any{"content": "我觉得还行", "parent_id": id(c1)}).obj(t)
	r2 := e.must(200, "POST", fmt.Sprintf("/trips/%d/comments", tripID), bob, map[string]any{"content": "好吧", "parent_id": id(r1)}).obj(t)
	if num(r2["parent_id"]) != float64(id(c1)) || r2["reply_to"] == nil || id(r2["reply_to"].(map[string]any)) != aliceID {
		t.Fatalf("reply to reply: %v", r2)
	}
	e.must(400, "POST", fmt.Sprintf("/trips/%d/comments", tripID), bob, map[string]any{"content": ""})
	cl := items(t, e.must(200, "GET", fmt.Sprintf("/trips/%d/comments", tripID), "", nil))
	if len(cl) != 1 || len(cl[0].(map[string]any)["replies"].([]any)) != 2 {
		t.Fatalf("comment tree: %v", cl)
	}
	// Deleting the top-level comment keeps a placeholder because it has replies.
	e.must(403, "DELETE", fmt.Sprintf("/comments/%d", id(r1)), bob, nil)   // not the author nor trip owner
	e.must(200, "DELETE", fmt.Sprintf("/comments/%d", id(c1)), alice, nil) // trip owner may delete
	cl = items(t, e.must(200, "GET", fmt.Sprintf("/trips/%d/comments", tripID), "", nil))
	if len(cl) != 1 || cl[0].(map[string]any)["deleted"] != true || cl[0].(map[string]any)["content"] != "" {
		t.Fatalf("deleted placeholder: %v", cl)
	}
	notes := items(t, e.must(200, "GET", "/notifications", alice, nil))
	types := map[string]bool{}
	for _, n := range notes {
		types[n.(map[string]any)["type"].(string)] = true
	}
	for _, want := range []string{"like", "favorite", "comment", "reply"} {
		if !types[want] {
			t.Fatalf("missing %s notification: %v", want, types)
		}
	}
	if cnt := e.must(200, "GET", "/notifications/unread-count", alice, nil).obj(t); num(cnt["count"]) == 0 {
		t.Fatal("unread count should be > 0")
	}
	e.must(200, "POST", "/notifications/read", alice, map[string]any{})
	if cnt := e.must(200, "GET", "/notifications/unread-count", alice, nil).obj(t); num(cnt["count"]) != 0 {
		t.Fatal("all notifications should be read")
	}

	// ---- follow ----
	f := e.must(200, "POST", "/users/alice/follow", bob, nil).obj(t)
	if f["following"] != true || num(f["followers"]) != 1 {
		t.Fatalf("follow: %v", f)
	}
	e.must(400, "POST", "/users/Bob_1/follow", bob, nil)
	if len(items(t, e.must(200, "GET", "/trips?tab=following", bob, nil))) != 1 {
		t.Fatal("following tab")
	}
	prof := e.must(200, "GET", "/users/alice", bob, nil).obj(t)
	if prof["is_following"] != true || num(prof["stats"].(map[string]any)["likes"]) != 1 {
		t.Fatalf("profile: %v", prof)
	}

	// ---- fork ----
	// A stop the author marked 踩雷 is not copied (unless asked for, with the warning in its note).
	snackPath := fmt.Sprintf("/waypoints/%d", id(extra["waypoint"].(map[string]any)))
	e.must(200, "PATCH", snackPath, alice, map[string]any{"verdict": "avoid", "note": "排队两小时，难吃"})
	fk := e.must(200, "POST", fmt.Sprintf("/trips/%d/fork", tripID), bob, map[string]any{"title": "我也要去杭州"}).obj(t)
	fwps := fk["waypoints"].([]any)
	if fk["phase"] != "planning" || fk["visibility"] != "private" || fk["forked_from"] == nil || len(fwps) != 4 {
		t.Fatalf("fork: phase=%v vis=%v forked=%v wps=%d", fk["phase"], fk["visibility"], fk["forked_from"], len(fwps))
	}
	for _, w := range fwps {
		wm := w.(map[string]any)
		if wm["planned"] != true || wm["status"] != "todo" || wm["verdict"] != "" || wm["arrived_at"] != nil || wm["name"] == "路边小吃" {
			t.Fatalf("forked waypoint: %v", wm)
		}
	}
	orig := e.must(200, "GET", fmt.Sprintf("/trips/%d", tripID), "", nil).obj(t)
	if num(orig["fork_count"]) != 1 || num(orig["view_count"]) < 1 || num(orig["planned_count"]) != 3 || num(orig["visited_count"]) != 4 {
		t.Fatalf("original after fork: fork=%v view=%v planned=%v visited=%v", orig["fork_count"], orig["view_count"], orig["planned_count"], orig["visited_count"])
	}
	withAvoid := e.must(200, "POST", fmt.Sprintf("/trips/%d/fork", tripID), bob, map[string]any{"include_avoid": true}).obj(t)
	snacks := 0
	for _, w := range withAvoid["waypoints"].([]any) {
		if wm := w.(map[string]any); wm["name"] == "路边小吃" {
			snacks++
			if wm["verdict"] != "" || wm["note"] != "⚠️ 原作者踩雷：排队两小时，难吃" {
				t.Fatalf("copied 踩雷 stop: %v", wm)
			}
		}
	}
	if len(withAvoid["waypoints"].([]any)) != 5 || snacks != 1 {
		t.Fatalf("fork with include_avoid: %v", withAvoid["waypoints"])
	}
	e.must(200, "DELETE", fmt.Sprintf("/trips/%d", id(withAvoid)), bob, nil)
	e.must(200, "PATCH", snackPath, alice, map[string]any{"verdict": "", "note": ""})
	// fork_count counts people holding a fork: forking again adds nothing (nor a notification), deleting forks subtracts.
	forkCount := func() float64 {
		return num(e.must(200, "GET", fmt.Sprintf("/trips/%d", tripID), alice, nil).obj(t)["fork_count"])
	}
	fk2 := e.must(200, "POST", fmt.Sprintf("/trips/%d/fork", tripID), bob, map[string]any{}).obj(t)
	if n := forkCount(); n != 1 {
		t.Fatalf("fork_count after a second fork by the same user: %v", n)
	}
	forkNotes := 0
	for _, n := range items(t, e.must(200, "GET", "/notifications", alice, nil)) {
		if n.(map[string]any)["type"] == "fork" {
			forkNotes++
		}
	}
	if forkNotes != 1 {
		t.Fatalf("fork notifications: %d", forkNotes)
	}
	e.must(200, "DELETE", fmt.Sprintf("/trips/%d", id(fk2)), bob, nil)
	e.must(200, "DELETE", fmt.Sprintf("/trips/%d", id(fk)), bob, nil)
	if n := forkCount(); n != 0 {
		t.Fatalf("fork_count after deleting the forks: %v", n)
	}
	e.must(200, "POST", fmt.Sprintf("/trips/%d/fork", tripID), bob, map[string]any{"title": "我也要去杭州"})
	if n := forkCount(); n != 1 {
		t.Fatalf("fork_count after forking again: %v", n)
	}

	// ---- track ----
	pts := []map[string]any{}
	base := time.Date(2026, 5, 1, 9, 0, 0, 0, time.UTC).UnixMilli()
	for i := 0; i < 50; i++ {
		lng, lat := geo.GCJ02ToWGS84(120.14+float64(i)*0.0005, 30.25)
		pts = append(pts, map[string]any{"lng": lng, "lat": lat, "alt": 10, "t": base + int64(i)*10000})
	}
	tr := e.must(200, "POST", fmt.Sprintf("/trips/%d/track", tripID), alice, map[string]any{"coord_type": "wgs84", "points": pts}).obj(t)
	if num(tr["accepted"]) != 50 || num(tr["distance_km"]) < 2.3 || num(tr["distance_km"]) > 2.5 {
		t.Fatalf("track append: %v", tr)
	}
	if again := e.must(200, "POST", fmt.Sprintf("/trips/%d/track", tripID), alice, map[string]any{"coord_type": "wgs84", "points": pts[:5]}).obj(t); num(again["accepted"]) != 0 {
		t.Fatalf("duplicate points accepted: %v", again)
	}
	tg := e.must(200, "GET", fmt.Sprintf("/trips/%d/track?max=10", tripID), "", nil).obj(t)
	segs := tg["segments"].([]any)
	if num(tg["point_count"]) != 50 || len(segs) != 1 || len(segs[0].([]any)) > 10 {
		t.Fatalf("track get: %v", tg)
	}
	// The trip's distance is the longer of the GPS track and the check-in route.
	tripKm := func() (got, want float64) {
		t.Helper()
		d := e.must(200, "GET", fmt.Sprintf("/trips/%d", tripID), "", nil).obj(t)
		if d["has_track"] != true {
			t.Fatalf("has_track: %v", d["has_track"])
		}
		act := e.must(200, "GET", fmt.Sprintf("/trips/%d/compare", tripID), "", nil).obj(t)["actual"].(map[string]any)
		return num(d["distance_km"]), math.Max(num(act["distance_km"]), num(act["track_distance_km"]))
	}
	if got, want := tripKm(); math.Abs(got-want) > 0.1 {
		t.Fatalf("trip distance %v, want max(check-in route, track) = %v", got, want)
	}
	trackPath := fmt.Sprintf("/trips/%d/track", tripID)
	gcjPts := func(n int, t0 int64, lng0, lat float64) []map[string]any {
		out := []map[string]any{}
		for i := 0; i < n; i++ {
			lng, lat := geo.GCJ02ToWGS84(lng0+float64(i)*0.0005, lat)
			out = append(out, map[string]any{"lng": lng, "lat": lat, "alt": 10, "t": t0 + int64(i)*10000})
		}
		return out
	}
	// Segment ids are chosen by the client; the web app uses the Unix seconds when recording starts.
	if r := e.must(200, "POST", trackPath, alice, map[string]any{"coord_type": "wgs84", "segment": 1790000000,
		"points": gcjPts(2, base+600000, 120.16, 30.26)}).obj(t); num(r["accepted"]) != 2 {
		t.Fatalf("unix-seconds segment: %v", r)
	}
	e.must(400, "POST", trackPath, alice, map[string]any{"segment": -1, "points": pts[:1]})
	if tg := e.must(200, "GET", trackPath, "", nil).obj(t); len(tg["segments"].([]any)) != 2 || num(tg["point_count"]) != 52 {
		t.Fatalf("two segments: %v", tg)
	}
	// Appends update the distance incrementally; points between stored ones, before
	// them and in another segment must give the same result as a full recomputation.
	e.must(200, "POST", trackPath, alice, map[string]any{"coord_type": "wgs84", "points": gcjPts(10, base+5000, 120.14025, 30.2503)})
	e.must(200, "POST", trackPath, alice, map[string]any{"coord_type": "wgs84", "points": gcjPts(3, base-30000, 120.1385, 30.2498)})
	last := e.must(200, "POST", trackPath, alice, map[string]any{"coord_type": "wgs84", "segment": 1,
		"points": gcjPts(5, base+100000, 120.15, 30.255)}).obj(t)
	var incremental, full float64
	e.svc.DB.Raw("SELECT track_distance_km FROM trips WHERE id = ?", tripID).Scan(&incremental)
	_ = e.svc.DB.Transaction(func(tx *gorm.DB) error {
		if err := e.svc.RecomputeTrack(tx, tripID); err != nil {
			t.Fatal(err)
		}
		tx.Raw("SELECT track_distance_km FROM trips WHERE id = ?", tripID).Scan(&full)
		return errors.New("roll back")
	})
	if math.Abs(incremental-full) > 0.01 || num(last["total_points"]) != 70 || math.Abs(num(last["distance_km"])-full) > 0.01 {
		t.Fatalf("incremental distance %.4f km, full recomputation %.4f km: %v", incremental, full, last)
	}
	if tg := e.must(200, "GET", trackPath, "", nil).obj(t); num(tg["point_count"]) != 70 || len(tg["segments"].([]any)) != 3 {
		t.Fatalf("track after appends: %v", tg)
	}
	if got, want := tripKm(); math.Abs(got-want) > 0.1 || want < full-0.01 {
		t.Fatalf("trip distance %v, want %v (track %.3f)", got, want, full)
	}
	// Clearing drops cached renders, even when the new track has the same point count.
	e.must(200, "DELETE", trackPath, alice, nil)
	e.must(200, "POST", trackPath, alice, map[string]any{"coord_type": "wgs84", "points": gcjPts(50, base, 120.14, 30.27)})
	tg = e.must(200, "GET", trackPath+"?max=10", "", nil).obj(t)
	if p0 := tg["segments"].([]any)[0].([]any)[0].([]any); num(tg["point_count"]) != 50 || math.Abs(num(p0[1])-30.27) > 0.0001 {
		t.Fatalf("stale track after clearing: %v", tg)
	}

	// Without live sharing, an ongoing trip's actual-travel data is for members only.
	e.must(200, "PATCH", fmt.Sprintf("/trips/%d", tripID), alice, map[string]any{"live_share": false})
	for _, q := range []string{"", "?share_code=" + shareCode} {
		if tg := e.must(200, "GET", trackPath+q, "", nil).obj(t); num(tg["point_count"]) != 0 || len(tg["segments"].([]any)) != 0 {
			t.Fatalf("hidden track%s: %v", q, tg)
		}
	}
	hid := e.must(200, "GET", fmt.Sprintf("/trips/%d", tripID), "", nil).obj(t)
	if hid["has_track"] != false || hid["live_share"] != false || len(hid["photos"].([]any)) != 0 || num(hid["visited_count"]) != 0 ||
		len(hid["waypoints"].([]any)) != 3 {
		t.Fatalf("hidden detail: has_track=%v photos=%d visited=%v wps=%d", hid["has_track"], len(hid["photos"].([]any)), hid["visited_count"], len(hid["waypoints"].([]any)))
	}
	for _, w := range hid["waypoints"].([]any) {
		if wm := w.(map[string]any); wm["planned"] != true || wm["arrived_at"] != nil || wm["status"] != "todo" || wm["verdict"] != "" {
			t.Fatalf("hidden waypoint: %v", wm)
		}
	}
	if hc := e.must(200, "GET", fmt.Sprintf("/trips/%d/compare", tripID), "", nil).obj(t); len(hc["extra"].([]any)) != 0 ||
		len(hc["visited"].([]any)) != 0 || num(hc["actual"].(map[string]any)["track_distance_km"]) != 0 {
		t.Fatalf("hidden compare: %v", hc)
	}
	if n := len(items(t, e.must(200, "GET", fmt.Sprintf("/places/%d/reviews", placeID), "", nil))); n != 0 {
		t.Fatalf("hidden trip still in place reviews: %d", n)
	}
	if st := e.must(200, "GET", "/users/alice/footprints", "", nil).obj(t)["stats"].(map[string]any); num(st["trips"]) != 0 {
		t.Fatalf("hidden trip still in public footprints: %v", st)
	}
	hfk := e.must(200, "POST", fmt.Sprintf("/trips/%d/fork", tripID), bob, map[string]any{}).obj(t)
	if len(hfk["waypoints"].([]any)) != 3 {
		t.Fatalf("fork of a hidden trip copied check-ins: %v", hfk["waypoints"])
	}
	e.must(200, "DELETE", fmt.Sprintf("/trips/%d", id(hfk)), bob, nil)
	if own := e.must(200, "GET", fmt.Sprintf("/trips/%d", tripID), alice, nil).obj(t); own["has_track"] != true || len(own["waypoints"].([]any)) != 5 {
		t.Fatalf("members see everything: %v", own["has_track"])
	}
	if tg := e.must(200, "GET", trackPath, alice, nil).obj(t); num(tg["point_count"]) != 50 {
		t.Fatalf("member track: %v", tg["point_count"])
	}
	e.must(200, "PATCH", fmt.Sprintf("/trips/%d", tripID), alice, map[string]any{"phase": "finished"})
	if tg := e.must(200, "GET", trackPath, "", nil).obj(t); num(tg["point_count"]) != 50 {
		t.Fatalf("finished trips are public again: %v", tg["point_count"])
	}
	e.must(200, "PATCH", fmt.Sprintf("/trips/%d", tripID), alice, map[string]any{"phase": "ongoing", "live_share": true})

	// ---- partner ----
	inv := e.must(200, "POST", "/partner/invites", alice, map[string]any{"username": "bob_1", "message": "一起走吧"}).obj(t)
	e.must(409, "POST", "/partner/invites", alice, map[string]any{"username": "bob_1"})
	e.must(409, "POST", "/partner/invites", bob, map[string]any{"username": "alice"})
	myInv := e.must(200, "GET", "/me/invites", bob, nil).obj(t)
	if len(myInv["partner_invites"].([]any)) != 1 {
		t.Fatalf("invites: %v", myInv)
	}
	pst := e.must(200, "POST", fmt.Sprintf("/partner/invites/%d/accept", id(inv)), bob, nil).obj(t)
	if pst["partner"] == nil || id(pst["partner"].(map[string]any)) != aliceID {
		t.Fatalf("partner accept: %v", pst)
	}
	// The anniversary may be today in Beijing time (also before 08:00, when UTC is still on the previous day), not later.
	bjToday := time.Now().In(e.svc.Loc)
	e.must(200, "PATCH", "/partner", alice, map[string]any{"since": bjToday.Format("2006-01-02")})
	e.must(400, "PATCH", "/partner", alice, map[string]any{"since": bjToday.AddDate(0, 0, 1).Format("2006-01-02")})
	e.must(200, "PATCH", "/partner", alice, map[string]any{"since": "2023-05-20", "title": "我们的小窝"})
	if p := e.must(200, "GET", "/partner", bob, nil).obj(t); p["since"] != "2023-05-20" || p["title"] != "我们的小窝" {
		t.Fatalf("partner shared settings: %v", p)
	}
	couple := e.must(200, "POST", "/trips", alice, map[string]any{"title": "周末苏州", "phase": "ongoing", "with_partner": true}).obj(t)
	if couple["together"] != true || len(couple["members"].([]any)) != 1 {
		t.Fatalf("together trip: %v", couple)
	}
	e.must(403, "PATCH", fmt.Sprintf("/trips/%d", id(couple)), bob, map[string]any{"live_share": true}) // owner only
	e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints", id(couple)), bob, map[string]any{"name": "拙政园", "lng": 120.6270, "lat": 31.3240})
	// Both partners record the same walk: the trip's distance is the longest member track, not the sum.
	coupleTrack := fmt.Sprintf("/trips/%d/track", id(couple))
	walk := gcjPts(50, base, 120.62, 31.32)
	e.must(200, "POST", coupleTrack, alice, map[string]any{"coord_type": "wgs84", "points": walk})
	both := e.must(200, "POST", coupleTrack, bob, map[string]any{"coord_type": "wgs84", "points": walk}).obj(t)
	if num(both["total_points"]) != 100 || num(both["distance_km"]) < 2.2 || num(both["distance_km"]) > 2.5 {
		t.Fatalf("two members' track: %v", both)
	}
	if d := e.must(200, "GET", fmt.Sprintf("/trips/%d", id(couple)), bob, nil).obj(t); num(d["distance_km"]) < 2.2 || num(d["distance_km"]) > 2.5 {
		t.Fatalf("couple trip distance: %v", d["distance_km"])
	}
	if tg := e.must(200, "GET", coupleTrack, bob, nil).obj(t); num(tg["point_count"]) != 100 || len(tg["segments"].([]any)) != 2 {
		t.Fatalf("couple track: %v %v", tg["point_count"], len(tg["segments"].([]any)))
	}
	pf := e.must(200, "GET", "/partner/footprints", bob, nil).obj(t)
	if st := pf["stats"].(map[string]any); num(st["trips"]) != 1 || num(st["cities"]) != 1 || num(st["distance_km"]) < 2.2 || num(st["distance_km"]) > 2.5 {
		t.Fatalf("partner footprints: %v", pf["stats"])
	}
	// A track stored before per-member distances were kept is measured in full on its next upload.
	e.svc.DB.Exec("DELETE FROM track_stats WHERE trip_id = ?", id(couple))
	e.svc.DB.Exec("UPDATE trips SET track_distance_km = 4.66, distance_km = 4.66 WHERE id = ?", id(couple))
	more := e.must(200, "POST", coupleTrack, alice, map[string]any{"coord_type": "wgs84", "points": gcjPts(5, base+500000, 120.645, 31.32)}).obj(t)
	var fullKm float64
	_ = e.svc.DB.Transaction(func(tx *gorm.DB) error {
		if err := e.svc.RecomputeTrack(tx, id(couple)); err != nil {
			t.Fatal(err)
		}
		tx.Raw("SELECT track_distance_km FROM trips WHERE id = ?", id(couple)).Scan(&fullKm)
		return errors.New("roll back")
	})
	if num(more["total_points"]) != 105 || fullKm < 2.4 || math.Abs(num(more["distance_km"])-fullKm) > 0.01 {
		t.Fatalf("upload to a pre-upgrade track: %v, full recomputation %.3f km", more, fullKm)
	}
	if pt := items(t, e.must(200, "GET", "/partner/trips", alice, nil)); len(pt) != 1 {
		t.Fatalf("partner trips: %v", pt)
	}
	fp := e.must(200, "GET", "/me/footprints", alice, nil).obj(t)
	provs := fp["provinces"].([]any)
	if len(provs) != 2 || num(fp["stats"].(map[string]any)["provinces"]) != 2 {
		t.Fatalf("footprints provinces: %v", provs)
	}
	// Footprints read only some columns: each field they need must still be filled in.
	if fp["stats"].(map[string]any)["first_date"] == nil || len(fp["trips"].([]any)) != 2 {
		t.Fatalf("footprints stats: %v, trips %v", fp["stats"], fp["trips"])
	}
	for _, ft := range fp["trips"].([]any) {
		tm := ft.(map[string]any)
		d := e.must(200, "GET", fmt.Sprintf("/trips/%d", id(tm)), alice, nil).obj(t)
		if tm["title"] == "" || tm["title"] != d["title"] || len(tm["path"].([]any)) != int(num(d["visited_count"])) ||
			num(tm["distance_km"]) == 0 || math.Abs(num(tm["distance_km"])-num(d["distance_km"])) > 0.05 {
			t.Fatalf("footprints trip %v: path %d, trip %v visited %v", tm["title"], len(tm["path"].([]any)), d["title"], d["visited_count"])
		}
	}
	for _, p := range fp["points"].([]any) {
		if pm := p.(map[string]any); pm["name"] == "" || pm["category"] == "" || pm["date"] == nil || pm["trip_title"] == "" || pm["city"] == "" {
			t.Fatalf("footprints point: %v", pm)
		}
	}
	ufp := e.must(200, "GET", "/users/alice/footprints", "", nil).obj(t) // only the public trip
	if num(ufp["stats"].(map[string]any)["trips"]) != 1 {
		t.Fatalf("public footprints: %v", ufp["stats"])
	}
	// Members management.
	e.must(409, "POST", fmt.Sprintf("/trips/%d/members", id(couple)), alice, map[string]any{"username": "bob_1"})
	carol, carolRefresh, _ := e.register("carol")
	second := e.must(200, "POST", "/auth/login", "", map[string]any{"account": "carol", "password": "secret123"}).obj(t)
	e.must(400, "POST", "/me/password", carol, map[string]any{"old_password": "nope", "new_password": "newsecret1"})
	e.must(200, "POST", "/me/password", carol, map[string]any{"old_password": "secret123", "new_password": "newsecret1"})
	e.must(200, "POST", "/auth/refresh", "", map[string]any{"refresh_token": carolRefresh})            // current session kept
	e.must(401, "POST", "/auth/refresh", "", map[string]any{"refresh_token": second["refresh_token"]}) // other sessions revoked
	e.must(401, "GET", "/me", second["access_token"].(string), nil)                                    // ...with their access tokens
	e.must(200, "GET", "/me", carol, nil)                                                              // an access token outlives its session's refresh
	// Logging out ends the session's access token too.
	third := e.must(200, "POST", "/auth/login", "", map[string]any{"account": "carol", "password": "newsecret1"}).obj(t)
	e.must(200, "GET", "/me", third["access_token"].(string), nil)
	e.must(200, "POST", "/auth/logout", "", map[string]any{"refresh_token": third["refresh_token"]})
	e.must(401, "GET", "/me", third["access_token"].(string), nil)
	e.must(200, "POST", fmt.Sprintf("/trips/%d/members", id(couple)), alice, map[string]any{"username": "carol"})
	mem := e.must(200, "GET", fmt.Sprintf("/trips/%d/members", id(couple)), bob, nil).arr(t)
	if len(mem) != 3 || mem[0].(map[string]any)["role"] != "owner" || mem[2].(map[string]any)["status"] != "pending" {
		t.Fatalf("members: %v", mem)
	}
	// Profiles show the relationship to the couple only, unless they make it public.
	if p := e.must(200, "GET", "/users/alice", "", nil).obj(t); p["partner"] != nil {
		t.Fatalf("guest sees a private relationship: %v", p["partner"])
	}
	for _, tok := range []string{alice, bob} {
		if p := e.must(200, "GET", "/users/alice", tok, nil).obj(t); p["partner"] == nil {
			t.Fatal("the couple should see their relationship")
		}
	}
	if p := e.must(200, "PATCH", "/partner", bob, map[string]any{"public": true}).obj(t); p["public"] != true {
		t.Fatalf("public: %v", p["public"])
	}
	if p := e.must(200, "GET", "/users/alice", "", nil).obj(t); p["partner"] == nil || id(p["partner"].(map[string]any)) != bobID {
		t.Fatalf("public relationship: %v", p["partner"])
	}
	// Unbinding can end the co-authorship of each other's trips.
	e.must(200, "DELETE", "/partner?remove_shared_access=true", alice, nil)
	e.must(404, "GET", fmt.Sprintf("/trips/%d", id(couple)), bob, nil)
	e.must(404, "PATCH", fmt.Sprintf("/trips/%d", id(couple)), bob, map[string]any{"title": "我的"})
	for _, m := range e.must(200, "GET", fmt.Sprintf("/trips/%d/members", id(couple)), alice, nil).arr(t) {
		if id(m.(map[string]any)["user"].(map[string]any)) == bobID {
			t.Fatalf("still a member after unbinding: %v", m)
		}
	}
	unbound := false
	for _, n := range items(t, e.must(200, "GET", "/notifications", bob, nil)) {
		unbound = unbound || strings.HasSuffix(n.(map[string]any)["content"].(string), "解除了情侣绑定，并结束了你们在彼此旅程中的共同作者关系")
	}
	if !unbound {
		t.Fatal("unbind notification")
	}

	// ---- place aggregates follow visibility ----
	e.must(200, "PATCH", fmt.Sprintf("/trips/%d", tripID), alice, map[string]any{"visibility": "private"})
	if n := len(items(t, e.must(200, "GET", "/places?q="+url.QueryEscape("楼外楼"), "", nil))); n != 0 {
		t.Fatal("private trip still counted in places")
	}
	e.must(200, "PATCH", fmt.Sprintf("/trips/%d", tripID), alice, map[string]any{"visibility": "public"})
	if n := len(items(t, e.must(200, "GET", "/places?q="+url.QueryEscape("楼外楼"), "", nil))); n != 1 {
		t.Fatal("place should be back")
	}

	// ---- admin ----
	admin := e.adminToken()
	e.must(403, "GET", "/admin/stats", alice, nil)
	stats := e.must(200, "GET", "/admin/stats", admin, nil).obj(t)
	if num(stats["users"]) != 4 || len(stats["trend"].([]any)) != 14 || num(stats["today"].(map[string]any)["trips"]) < 3 {
		t.Fatalf("stats: %v", stats)
	}
	feat := e.must(200, "PATCH", fmt.Sprintf("/admin/trips/%d", tripID), admin, map[string]any{"featured": true}).obj(t)
	if feat["featured"] != true {
		t.Fatalf("feature: %v", feat)
	}
	if len(items(t, e.must(200, "GET", "/trips?tab=featured", "", nil))) != 1 {
		t.Fatal("featured tab")
	}
	e.must(200, "PATCH", fmt.Sprintf("/admin/trips/%d", tripID), admin, map[string]any{"status": "hidden"})
	if len(items(t, e.must(200, "GET", "/trips", "", nil))) != 0 {
		t.Fatal("hidden trip listed")
	}
	e.must(404, "GET", fmt.Sprintf("/trips/%d", tripID), bob, nil)
	e.must(200, "GET", fmt.Sprintf("/trips/%d", tripID), alice, nil)
	e.must(200, "PATCH", fmt.Sprintf("/admin/trips/%d", tripID), admin, map[string]any{"status": "normal"})
	rep := e.must(200, "POST", "/reports", alice, map[string]any{"target_type": "user", "target_id": bobID, "reason": "广告"}).obj(t)
	reps := items(t, e.must(200, "GET", "/admin/reports?status=pending", admin, nil))
	if len(reps) != 1 || !strings.HasPrefix(reps[0].(map[string]any)["target_preview"].(string), "@Bob_1 · ") {
		t.Fatalf("reports: %v", reps)
	}
	e.must(200, "PATCH", fmt.Sprintf("/admin/reports/%d", id(rep)), admin, map[string]any{"status": "resolved", "note": "已处理"})
	e.must(200, "PATCH", fmt.Sprintf("/admin/users/%d", bobID), admin, map[string]any{"status": "banned"})
	if r := e.must(403, "GET", "/me", bob, nil).obj(t); r["error"].(map[string]any)["message"] != "账号已被封禁" {
		t.Fatalf("banned message: %v", r)
	}
	e.must(403, "POST", "/auth/login", "", map[string]any{"account": "bob_1", "password": "secret123"})
	e.must(200, "GET", "/trips", bob, nil) // public endpoints still work (as guest)
	au := items(t, e.must(200, "GET", "/admin/users?status=banned", admin, nil))
	if len(au) != 1 || au[0].(map[string]any)["status"] != "banned" {
		t.Fatalf("admin users: %v", au)
	}
	e.must(200, "PUT", "/admin/settings", admin, map[string]any{"announcement": "欢迎", "registration_open": false,
		"icp_beian": "京ICP备12345678号-1", "terms_md": "# {{site}} 协议\n自定义条款"})
	if s := e.must(200, "GET", "/site", "", nil).obj(t); s["announcement"] != "欢迎" || s["registration_open"] != false ||
		s["icp_beian"] != "京ICP备12345678号-1" || s["police_beian"] != "" {
		t.Fatalf("settings: %v", s)
	}
	e.must(400, "PUT", "/admin/settings", admin, map[string]any{"icp_beian": strings.Repeat("备", 51)})
	if terms := e.must(200, "GET", "/site/legal/terms", "", nil).obj(t); terms["content"] != "# TripHub 协议\n自定义条款" {
		t.Fatalf("custom terms: %v", terms)
	}
	if priv := e.must(200, "GET", "/site/legal/privacy", "", nil).obj(t)["content"].(string); !strings.Contains(priv, "TripHub 隐私政策") ||
		!strings.Contains(priv, "GPS 轨迹") || strings.Contains(priv, "{{site}}") {
		t.Fatalf("default privacy policy: %.200s", priv)
	}
	e.must(404, "GET", "/site/legal/cookies", "", nil)
	e.must(403, "POST", "/auth/register", "", map[string]any{"username": "dave", "password": "secret123", "agree_terms": true})
	ac := items(t, e.must(200, "GET", "/admin/comments", admin, nil))
	if len(ac) == 0 || ac[0].(map[string]any)["trip"] == nil && ac[0].(map[string]any)["place"] == nil {
		t.Fatalf("admin comments: %v", ac)
	}

	// ---- delete trip: files & quota released ----
	photoFile := filepath.Join(e.data, "uploads", filepath.FromSlash(strings.TrimPrefix(photo["url"].(string), "/uploads/")))
	if _, err := os.Stat(photoFile); err != nil {
		t.Fatalf("photo file missing: %v", err)
	}
	e.must(200, "DELETE", fmt.Sprintf("/trips/%d", tripID), alice, nil)
	if _, err := os.Stat(photoFile); !os.IsNotExist(err) {
		t.Fatalf("photo file should be deleted: %v", err)
	}
	if m := e.must(200, "GET", "/me", alice, nil).obj(t); num(m["storage_used"]) != 0 {
		t.Fatalf("storage should be released: %v", m["storage_used"])
	}
	e.must(404, "GET", fmt.Sprintf("/trips/%d", tripID), alice, nil)
	if n := len(items(t, e.must(200, "GET", "/places", "", nil))); n != 0 {
		t.Fatalf("places should have no public check-ins left, got %d", n)
	}
	// Levels: alice earned exp along the way.
	if m := e.must(200, "GET", "/me", alice, nil).obj(t); num(m["exp"]) < 50 || num(m["level"]) < 2 {
		t.Fatalf("exp/level: exp=%v level=%v", m["exp"], m["level"])
	}
}

func (e *env) adminToken() string {
	e.t.Helper()
	m := e.must(200, "POST", "/auth/login", "", map[string]any{"account": "root", "password": "rootpass123"}).obj(e.t)
	return m["access_token"].(string)
}

// burst sends n requests at once (all released together) and counts the status codes.
func (e *env) burst(n int, path string, body func(i int) map[string]any) map[int]int {
	start := make(chan struct{})
	var wg sync.WaitGroup
	var mu sync.Mutex
	codes := map[int]int{}
	for i := 0; i < n; i++ {
		b, _ := json.Marshal(body(i))
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			code := 0
			if res, err := http.Post(e.base+path, "application/json", bytes.NewReader(b)); err == nil {
				_, _ = io.Copy(io.Discard, res.Body)
				res.Body.Close()
				code = res.StatusCode
			}
			mu.Lock()
			codes[code]++
			mu.Unlock()
		}()
	}
	close(start)
	wg.Wait()
	return codes
}

func TestAuthRateLimitConcurrency(t *testing.T) {
	e := setup(t)
	e.register("victim")
	// Parallel guesses must not all pass the check before any failure is counted.
	codes := e.burst(20, "/auth/login", func(int) map[string]any {
		return map[string]any{"account": "victim", "password": "wrong-password"}
	})
	if codes[401] != 5 || codes[429] != 15 {
		t.Fatalf("login burst: %v, want 5×401 and 15×429", codes)
	}
	e.must(200, "POST", "/auth/login", "", map[string]any{"account": "victim@example.com", "password": "secret123"})
	// 10 registrations per IP and hour; "victim" used one.
	codes = e.burst(15, "/auth/register", func(i int) map[string]any {
		return map[string]any{"username": fmt.Sprintf("burst%d", i), "password": "secret123", "agree_terms": true}
	})
	if codes[200] != 9 || codes[429] != 6 {
		t.Fatalf("register burst: %v, want 9×200 and 6×429", codes)
	}
	// A refresh token can be used once, however many requests race with it.
	login := e.must(200, "POST", "/auth/login", "", map[string]any{"account": "victim@example.com", "password": "secret123"}).obj(t)
	codes = e.burst(8, "/auth/refresh", func(int) map[string]any { return map[string]any{"refresh_token": login["refresh_token"]} })
	if codes[200] != 1 || codes[401] != 7 {
		t.Fatalf("refresh burst: %v, want 1×200 and 7×401", codes)
	}
	e.must(200, "GET", "/me", login["access_token"].(string), nil)
}

func TestPlacePrivacy(t *testing.T) {
	e := setup(t)
	alice, _, _ := e.register("alice")
	mallory, _, _ := e.register("mallory")
	home := fmt.Sprintf("/trips/%d/waypoints", id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "回家"}).obj(t)))
	wps := e.must(200, "POST", home+"/batch", alice, map[string]any{"items": []any{
		map[string]any{"name": "我家", "address": "杭州市西湖区某小区3幢2单元501", "lng": 120.1300, "lat": 30.2700, "planned": false},
		map[string]any{"name": "楼外楼", "address": "私人地址 88 号", "lng": 120.2222, "lat": 30.3333, "category": "food"},
	}}).arr(t)
	homePlace := int64(num(wps[0].(map[string]any)["place_id"]))
	if homePlace == 0 || wps[1].(map[string]any)["place_id"] == nil {
		t.Fatalf("places not created: %v", wps)
	}
	// Alice's own waypoints keep joining her places.
	if w := e.must(200, "POST", home, alice, map[string]any{"name": "我家", "lng": 120.1302, "lat": 30.2701}).obj(t); int64(num(w["place_id"])) != homePlace {
		t.Fatalf("own place not reused: %v", w)
	}
	// The same name ~77 m away in someone else's trip must not join (and so reveal) the private place.
	mt := id(e.must(200, "POST", "/trips", mallory, map[string]any{"title": "探索"}).obj(t))
	mw := e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints", mt), mallory, map[string]any{"name": "我家", "lng": 120.1308, "lat": 30.2700, "planned": false}).obj(t)
	if mw["place_id"] == nil || int64(num(mw["place_id"])) == homePlace {
		t.Fatalf("private place joined by name: %v", mw["place_id"])
	}
	e.must(200, "GET", fmt.Sprintf("/places/%d", homePlace), alice, nil)
	e.must(404, "GET", fmt.Sprintf("/places/%d", homePlace), mallory, nil)
	e.must(200, "PATCH", fmt.Sprintf("/trips/%d", mt), mallory, map[string]any{"visibility": "public"})
	e.must(404, "GET", fmt.Sprintf("/places/%d", homePlace), "", nil)
	found := e.must(200, "GET", "/places?q="+url.QueryEscape("我家"), "", nil)
	if n := len(items(t, found)); n != 1 || strings.Contains(string(found.body), "3幢2单元501") {
		t.Fatalf("place search: %s", found.body)
	}
	// AI plans only use public places: the private 楼外楼 must not lend its position or address.
	plan := e.must(200, "POST", "/ai/plan", mallory, map[string]any{"destination": "杭州", "days": 2})
	for _, it := range plan.obj(t)["items"].([]any) {
		if m := it.(map[string]any); m["name"] == "楼外楼" && (m["place_id"] != nil || m["lng"] != nil) {
			t.Fatalf("AI plan linked a private place: %v", m)
		}
	}
	if strings.Contains(string(plan.body), "私人地址") {
		t.Fatalf("AI plan leaked a private address: %s", plan.body)
	}
	// Once the trip is public (with a check-in there), others join its place.
	e.must(200, "PATCH", strings.TrimSuffix(home, "/waypoints"), alice, map[string]any{"visibility": "public"})
	near := e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints", mt), mallory, map[string]any{"name": "我家", "lng": 120.1300, "lat": 30.27005}).obj(t)
	if int64(num(near["place_id"])) != homePlace {
		t.Fatalf("public place not joined: %v", near["place_id"])
	}
}

func gpxFile(withTimes bool, pts ...[2]float64) []byte {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>`)
	for i, p := range pts {
		lng, lat := geo.GCJ02ToWGS84(p[0], p[1])
		fmt.Fprintf(&b, `<trkpt lat="%.7f" lon="%.7f"><ele>%d</ele>`, lat, lng, 10+i)
		if withTimes {
			fmt.Fprintf(&b, `<time>2026-05-01T01:%02d:00Z</time>`, i)
		}
		b.WriteString(`</trkpt>`)
	}
	b.WriteString(`</trkseg></trk></gpx>`)
	return []byte(b.String())
}

func TestTrackImport(t *testing.T) {
	e := setup(t)
	alice, _, _ := e.register("alice")
	bob, _, _ := e.register("bob")
	tid := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "徒步"}).obj(t))
	path := fmt.Sprintf("/trips/%d/track/import", tid)
	file := gpxFile(true, [2]float64{120.1500, 30.2600}, [2]float64{120.1510, 30.2600}, [2]float64{120.1520, 30.2600})
	r := e.upload(path, alice, file, nil)
	if r.status != 200 {
		t.Fatalf("import: %d %s", r.status, r.body)
	}
	if m := r.obj(t); num(m["accepted"]) != 3 || num(m["segments"]) != 1 || num(m["distance_km"]) < 0.18 || num(m["distance_km"]) > 0.2 {
		t.Fatalf("import result: %v", m)
	}
	tg := e.must(200, "GET", fmt.Sprintf("/trips/%d/track", tid), alice, nil).obj(t)
	segs := tg["segments"].([]any)
	if len(segs) != 1 || len(segs[0].([]any)) != 3 {
		t.Fatalf("imported track: %v", tg)
	}
	if p0 := segs[0].([]any)[0].([]any); geo.Haversine(num(p0[0]), num(p0[1]), 120.15, 30.26) > 1 || num(p0[2]) != 10 {
		t.Fatalf("WGS-84 not converted to GCJ-02: %v", p0)
	}
	if r := e.upload(path, alice, file, nil); r.status != 200 || num(r.obj(t)["accepted"]) != 0 {
		t.Fatalf("re-import: %d %s", r.status, r.body)
	}
	if r := e.upload(path, alice, gpxFile(false, [2]float64{120.15, 30.26}), nil); r.status != 400 {
		t.Fatalf("GPX without times: %d %s", r.status, r.body)
	}
	if r := e.upload(path, alice, []byte("not xml <"), nil); r.status != 400 {
		t.Fatalf("broken file: %d %s", r.status, r.body)
	}
	if r := e.upload(path, bob, file, nil); r.status != 404 {
		t.Fatalf("non-member import: %d", r.status)
	}
	if d := e.must(200, "GET", fmt.Sprintf("/trips/%d", tid), alice, nil).obj(t); d["phase"] != "planning" || d["has_track"] != true {
		t.Fatalf("import should not start the trip: %v %v", d["phase"], d["has_track"])
	}
}

func TestAccountDeletion(t *testing.T) {
	e := setup(t)
	alice, _, aliceID := e.register("alice")
	bob, _, bobID := e.register("bob")
	admin := e.adminToken()
	inv := e.must(200, "POST", "/partner/invites", alice, map[string]any{"username": "bob"}).obj(t)
	e.must(200, "POST", fmt.Sprintf("/partner/invites/%d/accept", id(inv)), bob, nil)
	solo := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "独自旅行", "visibility": "public"}).obj(t))
	shared := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "一起旅行", "phase": "ongoing", "with_partner": true}).obj(t))
	var photoURLs []string
	for _, tok := range []string{alice, bob} {
		r := e.upload(fmt.Sprintf("/trips/%d/photos", shared), tok, testJPEG(t, 300, 200), nil)
		if r.status != 200 {
			t.Fatalf("upload: %d %s", r.status, r.body)
		}
		photoURLs = append(photoURLs, r.obj(t)["photo"].(map[string]any)["url"].(string))
	}
	e.must(200, "POST", fmt.Sprintf("/trips/%d/track", shared), alice, map[string]any{"points": []any{
		map[string]any{"lng": 120.62, "lat": 31.32, "t": time.Now().Add(-time.Hour).UnixMilli()},
		map[string]any{"lng": 120.63, "lat": 31.32, "t": time.Now().UnixMilli()},
	}})
	bt := id(e.must(200, "POST", "/trips", bob, map[string]any{"title": "鲍勃的旅程", "visibility": "public"}).obj(t))
	cm := e.must(200, "POST", fmt.Sprintf("/trips/%d/comments", bt), alice, map[string]any{"content": "好美"}).obj(t)
	e.must(200, "POST", fmt.Sprintf("/trips/%d/comments", bt), bob, map[string]any{"content": "谢谢", "parent_id": id(cm)})
	e.must(200, "POST", fmt.Sprintf("/trips/%d/like", bt), alice, nil)
	e.must(200, "POST", "/users/bob/follow", alice, nil)

	e.must(400, "DELETE", "/me", alice, map[string]any{"password": "wrong-password"})
	e.must(400, "DELETE", "/me", admin, map[string]any{"password": "rootpass123"})
	e.must(200, "DELETE", "/me", alice, map[string]any{"password": "secret123"})

	e.must(401, "GET", "/me", alice, nil)
	e.must(401, "POST", "/auth/login", "", map[string]any{"account": "alice", "password": "secret123"})
	e.must(404, "GET", "/users/alice", "", nil)
	e.must(404, "GET", fmt.Sprintf("/trips/%d", solo), admin, nil)
	st := e.must(200, "GET", fmt.Sprintf("/trips/%d", shared), bob, nil).obj(t)
	if st["is_owner"] != true || id(st["author"].(map[string]any)) != bobID || len(st["photos"].([]any)) != 1 ||
		st["has_track"] != false || len(st["members"].([]any)) != 0 {
		t.Fatalf("shared trip after deletion: owner=%v author=%v photos=%d track=%v", st["is_owner"], st["author"], len(st["photos"].([]any)), st["has_track"])
	}
	for i, u := range photoURLs {
		_, err := os.Stat(filepath.Join(e.data, "uploads", filepath.FromSlash(strings.TrimPrefix(u, "/uploads/"))))
		if deleted := os.IsNotExist(err); deleted != (i == 0) {
			t.Fatalf("photo %d file deleted=%v (%v)", i, deleted, err)
		}
	}
	cl := items(t, e.must(200, "GET", fmt.Sprintf("/trips/%d/comments", bt), "", nil))
	if c0 := cl[0].(map[string]any); len(cl) != 1 || c0["deleted"] != true || c0["content"] != "" ||
		c0["author"].(map[string]any)["nickname"] != "已注销用户" || len(c0["replies"].([]any)) != 1 {
		t.Fatalf("comment of a deleted account: %v", cl)
	}
	if d := e.must(200, "GET", fmt.Sprintf("/trips/%d", bt), bob, nil).obj(t); num(d["like_count"]) != 0 || num(d["comment_count"]) != 1 {
		t.Fatalf("counters: likes=%v comments=%v", d["like_count"], d["comment_count"])
	}
	if p := e.must(200, "GET", "/partner", bob, nil).obj(t); p["partner"] != nil {
		t.Fatalf("partner binding kept: %v", p)
	}
	if prof := e.must(200, "GET", "/users/bob", "", nil).obj(t); num(prof["stats"].(map[string]any)["followers"]) != 0 {
		t.Fatalf("follow kept: %v", prof["stats"])
	}
	e.must(404, "POST", "/partner/invites", bob, map[string]any{"username": fmt.Sprintf("deleted-%d", aliceID)})
	au := items(t, e.must(200, "GET", "/admin/users?status=deleted", admin, nil))
	if len(au) != 1 || au[0].(map[string]any)["username"] != fmt.Sprintf("deleted-%d", aliceID) || au[0].(map[string]any)["email"] != "" {
		t.Fatalf("anonymised user: %v", au)
	}
	e.must(400, "PATCH", fmt.Sprintf("/admin/users/%d", aliceID), admin, map[string]any{"status": "active"})
	e.must(400, "POST", fmt.Sprintf("/admin/users/%d/reset-password", aliceID), admin, map[string]any{})
	e.register("alice") // the name is free again
}

func TestAdminAccountRecovery(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	tok, _, _ := e.register("seedcheck")
	// TRIPHUB_ADMIN_USERNAME naming an existing user promotes it only with that user's password.
	for _, tc := range []struct{ pw, want string }{
		{"wrongpass1", service.SeedConflict}, {"secret123", service.SeedPromoted},
		{"another-pw", service.SeedExists}, {"secret123", ""},
	} {
		if res, err := e.svc.SeedAdmin(ctx, "SeedCheck", tc.pw); err != nil || res != tc.want {
			t.Fatalf("SeedAdmin(%q) = %q, %v; want %q", tc.pw, res, err, tc.want)
		}
		if tc.want == service.SeedConflict {
			e.must(403, "GET", "/admin/stats", tok, nil)
		}
	}
	e.must(200, "GET", "/admin/stats", tok, nil)
	e.must(200, "POST", "/auth/login", "", map[string]any{"account": "seedcheck", "password": "secret123"}) // password unchanged
	if res, err := e.svc.SeedAdmin(ctx, "newadmin", "newpass123"); err != nil || res != service.SeedCreated {
		t.Fatalf("create admin: %q %v", res, err)
	}
	// A new admin's password must meet the password policy: the example .env placeholder never becomes a login.
	for _, pw := range []string{"1", "change-me-admin-password"} {
		if res, err := e.svc.SeedAdmin(ctx, "adm2", pw); err == nil {
			t.Fatalf("SeedAdmin with password %q: %q, want an error", pw, res)
		}
	}
	e.must(400, "POST", "/auth/register", "", map[string]any{"username": "shortpw", "password": "1234567", "agree_terms": true})

	admin := e.adminToken()
	rootID := id(e.must(200, "GET", "/me", admin, nil).obj(t))
	carol, carolRefresh, carolID := e.register("carol")
	reset := fmt.Sprintf("/admin/users/%d/reset-password", carolID)
	e.must(403, "POST", reset, carol, map[string]any{})
	e.must(400, "POST", fmt.Sprintf("/admin/users/%d/reset-password", rootID), admin, map[string]any{})
	e.must(400, "POST", reset, admin, map[string]any{"password": "123"})
	e.must(404, "POST", "/admin/users/999999/reset-password", admin, map[string]any{})
	pw := e.must(200, "POST", reset, admin, map[string]any{}).obj(t)["password"].(string)
	if len(pw) != 12 {
		t.Fatalf("generated password %q", pw)
	}
	e.must(401, "POST", "/auth/login", "", map[string]any{"account": "carol", "password": "secret123"})
	e.must(401, "POST", "/auth/refresh", "", map[string]any{"refresh_token": carolRefresh})
	e.must(200, "POST", "/auth/login", "", map[string]any{"account": "carol", "password": pw})
	if r := e.must(200, "POST", reset, admin, map[string]any{"password": "chosen-pass"}).obj(t); r["password"] != "chosen-pass" {
		t.Fatalf("chosen password: %v", r)
	}
	e.must(200, "POST", "/auth/login", "", map[string]any{"account": "carol", "password": "chosen-pass"})
}

// parallel runs fn(0), …, fn(n-1) at the same moment and waits for all of them.
func parallel(n int, fn func(i int)) {
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			fn(i)
		}(i)
	}
	close(start)
	wg.Wait()
}

// status performs a request (from any goroutine) and returns the status code, 0 on transport errors.
func (e *env) status(method, path, token string, body any) int {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	r, _ := http.NewRequest(method, e.base+path, rd)
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		return 0
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, res.Body)
	return res.StatusCode
}

// parallelOK sends the n requests of req(i) at the same moment and asserts they all succeed.
func (e *env) parallelOK(n int, req func(i int) (method, path, token string, body any)) {
	e.t.Helper()
	codes := make([]int, n)
	parallel(n, func(i int) { codes[i] = e.status(req(i)) })
	for i, c := range codes {
		if c != 200 {
			m, p, _, _ := req(i)
			e.t.Fatalf("%s %s: status %d", m, p, c)
		}
	}
}

func TestGeoEndpoints(t *testing.T) {
	e := setup(t)
	tok, _, _ := e.register("mapper")
	search := "/geo/search?keyword=" + url.QueryEscape("杭州")
	regeo := "/geo/regeo?lng=120.15&lat=30.26"
	// Guests would spend the operator's AMap quota.
	e.must(401, "GET", search, "", nil)
	e.must(401, "GET", regeo, "", nil)
	if r := e.must(200, "GET", search, tok, nil).obj(t); r["source"] != "local" || len(r["items"].([]any)) == 0 {
		t.Fatalf("offline search: %v", r)
	}
	if r := e.must(200, "GET", regeo, tok, nil).obj(t); r["city"] != "杭州市" {
		t.Fatalf("regeo: %v", r)
	}
	// 120 calls per user in 10 minutes, search and regeo together.
	for i := 2; i < 120; i++ {
		e.must(200, "GET", regeo, tok, nil)
	}
	e.must(429, "GET", search, tok, nil)
	e.must(429, "GET", regeo, tok, nil)
}

func TestPlacePoisoning(t *testing.T) {
	e := setup(t) // no AMap key: an amap_id cannot be verified
	mallory, _, _ := e.register("mallory")
	alice, _, _ := e.register("alice")
	// Mallory claims the real 楼外楼 POI ID with a spam name, in Beijing, marked 踩雷.
	mt := id(e.must(200, "POST", "/trips", mallory, map[string]any{"title": "北京", "visibility": "public", "phase": "finished"}).obj(t))
	spam := e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints", mt), mallory, map[string]any{
		"name": "黑店勿去 加微信xxx", "lng": 116.40, "lat": 39.90, "amap_id": "B023B0J1V1", "verdict": "avoid"}).obj(t)
	spamPlace := int64(num(spam["place_id"]))
	if p := e.must(200, "GET", fmt.Sprintf("/places/%d", spamPlace), "", nil).obj(t); spamPlace == 0 || p["amap_id"] != "" {
		t.Fatalf("an unverified amap_id defined a shared place: %v", p)
	}
	// An honest check-in at the real 楼外楼 with the same POI ID gets its own, correct place.
	at := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "杭州", "visibility": "public", "phase": "finished"}).obj(t))
	honest := e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints", at), alice, map[string]any{
		"name": "楼外楼", "lng": 120.1437, "lat": 30.2556, "amap_id": "B023B0J1V1", "verdict": "recommend"}).obj(t)
	hp := int64(num(honest["place_id"]))
	if hp == 0 || hp == spamPlace {
		t.Fatalf("honest waypoint joined the spam place: %v", honest["place_id"])
	}
	if p := e.must(200, "GET", fmt.Sprintf("/places/%d", hp), "", nil).obj(t); p["name"] != "楼外楼" || p["city"] != "杭州市" || num(p["avoid_count"]) != 0 {
		t.Fatalf("honest place: %v", p)
	}
	if near := e.must(200, "GET", "/places/nearby?lng=120.1437&lat=30.2556&radius=500", "", nil).arr(t); len(near) != 1 || id(near[0].(map[string]any)) != hp {
		t.Fatalf("nearby: %v", near)
	}

	// One person's repeated 踩雷 check-ins at a place count once.
	batch := make([]any, 30)
	for i := range batch {
		batch[i] = map[string]any{"name": "某网红店", "lng": 120.16, "lat": 30.27, "verdict": "avoid", "note": "排队两小时"}
	}
	saved := e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints/batch", mt), mallory, map[string]any{"items": batch}).arr(t)
	pid := int64(num(saved[0].(map[string]any)["place_id"]))
	if p := e.must(200, "GET", fmt.Sprintf("/places/%d", pid), "", nil).obj(t); num(p["avoid_count"]) != 1 || num(p["checkin_count"]) != 1 {
		t.Fatalf("30 check-ins by one person: checkin_count=%v avoid_count=%v", p["checkin_count"], p["avoid_count"])
	}
	// ...and one person's 踩雷 is no warning yet.
	ot := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "逛街", "phase": "ongoing"}).obj(t))
	recPath := fmt.Sprintf("/trips/%d/recommend?lng=120.1605&lat=30.2705", ot)
	warnings := func() []any { return e.must(200, "GET", recPath, alice, nil).obj(t)["warnings"].([]any) }
	if ws := warnings(); len(ws) != 0 {
		t.Fatalf("one person's 踩雷 gave a warning: %v", ws)
	}
	// A second person's does, with one note per person.
	shop := fmt.Sprintf("/trips/%d/waypoints", at)
	stats := func() map[string]any { return e.must(200, "GET", fmt.Sprintf("/places/%d", pid), "", nil).obj(t) }
	aw := e.must(200, "POST", shop, alice, map[string]any{"name": "某网红店", "lng": 120.1601, "lat": 30.2701, "verdict": "avoid",
		"note": "服务态度差", "arrived_at": "2026-05-01T12:00:00+08:00"}).obj(t)
	if p := stats(); int64(num(aw["place_id"])) != pid || num(p["avoid_count"]) != 2 {
		t.Fatalf("second 踩雷: place %v, %v", aw["place_id"], p)
	}
	if ws := warnings(); len(ws) != 1 || ws[0].(map[string]any)["reason"] != "2 人踩雷：服务态度差；排队两小时" {
		t.Fatalf("warnings: %v", ws)
	}
	// Each person counts with their latest opinion (by arrival time): a later 推荐 replaces the 踩雷.
	for _, v := range []struct{ verdict, at string }{{"recommend", "2026-06-01T12:00:00+08:00"}, {"avoid", "2026-04-01T12:00:00+08:00"}} {
		e.must(200, "POST", shop, alice, map[string]any{"name": "某网红店", "lng": 120.1601, "lat": 30.2701, "verdict": v.verdict, "arrived_at": v.at})
	}
	if p := stats(); num(p["checkin_count"]) != 2 || num(p["avoid_count"]) != 1 || num(p["recommend_count"]) != 1 {
		t.Fatalf("latest opinion per person: %v", p)
	}
	if ws := warnings(); len(ws) != 0 {
		t.Fatalf("warnings after a later 推荐: %v", ws)
	}
	// Statistics stored by an older version are recomputed once (at startup).
	ctx := context.Background()
	e.svc.DB.Exec("UPDATE places SET checkin_count = 30, avoid_count = 30 WHERE id = ?", pid)
	if err := e.svc.BackfillPlaceStats(ctx); err != nil {
		t.Fatal(err)
	}
	if p := stats(); num(p["checkin_count"]) != 2 || num(p["avoid_count"]) != 1 {
		t.Fatalf("backfilled place: %v", p)
	}
	e.svc.DB.Exec("UPDATE places SET checkin_count = 30 WHERE id = ?", pid)
	if err := e.svc.BackfillPlaceStats(ctx); err != nil {
		t.Fatal(err)
	}
	if p := stats(); num(p["checkin_count"]) != 30 {
		t.Fatalf("backfill ran twice: %v", p)
	}
}

// fakeAmap serves the AMap endpoints used by waypoint creation: one known POI.
func fakeAmap(t *testing.T) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("key") == "" {
			t.Errorf("amap request without key: %s", r.URL)
		}
		switch {
		case r.URL.Path == "/v3/place/detail" && r.URL.Query().Get("id") == "B023B0J1V1":
			_, _ = w.Write([]byte(`{"status":"1","count":"1","infocode":"10000","pois":[{"id":"B023B0J1V1","name":"楼外楼(孤山路店)",
				"type":"餐饮服务;中餐厅;浙江菜","address":"孤山路30号","location":"120.143700,30.255600","pname":"浙江省",
				"cityname":"杭州市","adname":"西湖区","tel":"0571-87969023"}]}`))
		case r.URL.Path == "/v3/place/text" && r.URL.Query().Get("keywords") == "楼外楼":
			_, _ = w.Write([]byte(`{"status":"1","count":"2","infocode":"10000","pois":[{"id":"B023B0J1V1","name":"楼外楼(孤山路店)",
				"type":"餐饮服务;中餐厅;浙江菜","address":"孤山路30号","location":"120.143700,30.255600","pname":"浙江省",
				"cityname":"杭州市","adname":"西湖区"},{"id":"B0OTHER001","name":"楼外楼(西溪店)","type":"餐饮服务;中餐厅",
				"address":"西溪路1号","location":"120.090000,30.270000","pname":"浙江省","cityname":"杭州市","adname":"西湖区"}]}`))
		case r.URL.Path == "/v3/geocode/regeo":
			_, _ = w.Write([]byte(`{"status":"1","infocode":"10000","regeocode":{"formatted_address":[],"addressComponent":{}}}`))
		default:
			_, _ = w.Write([]byte(`{"status":"1","count":"0","infocode":"10000","pois":[]}`))
		}
	}))
}

func TestPlaceFromAmap(t *testing.T) {
	e := setup(t)
	srv := fakeAmap(t)
	t.Cleanup(srv.Close)
	am := amap.New("test-key")
	am.SetBaseURL(srv.URL)
	e.svc.Amap = am // before any request
	alice, _, _ := e.register("alice")
	mallory, _, _ := e.register("mallory")
	at := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "杭州", "visibility": "public", "phase": "finished"}).obj(t))
	w := e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints", at), alice, map[string]any{
		"name": "楼外楼", "lng": 120.1438, "lat": 30.2557, "amap_id": "B023B0J1V1"}).obj(t)
	pid := int64(num(w["place_id"]))
	p := e.must(200, "GET", fmt.Sprintf("/places/%d", pid), "", nil).obj(t)
	if w["name"] != "楼外楼" || p["name"] != "楼外楼(孤山路店)" || p["amap_id"] != "B023B0J1V1" || p["address"] != "孤山路30号" ||
		p["tel"] != "0571-87969023" || p["category"] != "food" || num(p["lng"]) != 120.1437 {
		t.Fatalf("place from AMap data: waypoint %v, place %v", w["name"], p)
	}
	mt := id(e.must(200, "POST", "/trips", mallory, map[string]any{"title": "北京", "visibility": "public", "phase": "finished"}).obj(t))
	// The POI ID cannot pull a far-away waypoint (and its name) into AMap's place...
	far := e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints", mt), mallory, map[string]any{
		"name": "黑店勿去", "lng": 116.40, "lat": 39.90, "amap_id": "B023B0J1V1", "verdict": "avoid"}).obj(t)
	if fp := int64(num(far["place_id"])); fp == 0 || fp == pid {
		t.Fatalf("far waypoint: %v", far["place_id"])
	}
	// ...a nearby one joins it, but only adds its opinion.
	nearW := e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints", mt), mallory, map[string]any{
		"name": "黑店勿去 加微信", "lng": 120.1440, "lat": 30.2560, "amap_id": "B023B0J1V1", "verdict": "avoid"}).obj(t)
	if int64(num(nearW["place_id"])) != pid {
		t.Fatalf("nearby waypoint should join AMap's place: %v", nearW["place_id"])
	}
	if p := e.must(200, "GET", fmt.Sprintf("/places/%d", pid), "", nil).obj(t); p["name"] != "楼外楼(孤山路店)" ||
		num(p["checkin_count"]) != 2 || num(p["avoid_count"]) != 1 {
		t.Fatalf("place after a nearby check-in: %v", p)
	}
	// Place search shows the community verdicts of the results that have public check-ins.
	found := e.must(200, "GET", "/geo/search?keyword="+url.QueryEscape("楼外楼"), alice, nil).obj(t)["items"].([]any)
	if len(found) != 2 || found[1].(map[string]any)["place"] != nil {
		t.Fatalf("search results: %v", found)
	}
	if ps, _ := found[0].(map[string]any)["place"].(map[string]any); ps == nil || int64(num(ps["id"])) != pid ||
		num(ps["checkin_count"]) != 2 || num(ps["avoid_count"]) != 1 {
		t.Fatalf("community stats of a search result: %v", found[0])
	}
	// An ID AMap does not know is matched by name.
	unk := e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints", at), alice, map[string]any{
		"name": "小面馆", "lng": 120.15, "lat": 30.26, "amap_id": "B0NOSUCH00"}).obj(t)
	if p := e.must(200, "GET", fmt.Sprintf("/places/%d", int64(num(unk["place_id"]))), "", nil).obj(t); p["amap_id"] != "" || p["name"] != "小面馆" {
		t.Fatalf("unknown POI ID: %v", p)
	}
}

func TestConcurrentCounters(t *testing.T) {
	e := setup(t)
	const n = 8
	toks := make([]string, n)
	for i := range toks {
		toks[i], _, _ = e.register(fmt.Sprintf("fan%d", i))
	}
	owner := toks[0]
	tid := id(e.must(200, "POST", "/trips", owner, map[string]any{"title": "人气旅程", "visibility": "public", "phase": "finished"}).obj(t))
	w := e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints", tid), owner, map[string]any{"name": "楼外楼", "lng": 120.1437, "lat": 30.2556}).obj(t)
	pid := int64(num(w["place_id"]))
	trip := fmt.Sprintf("/trips/%d", tid)
	// check asserts that the stored counters equal the rows (and the expected numbers).
	check := func(step string, likes, favs, comments, placeComments int64) {
		t.Helper()
		var r struct{ Lc, Fc, Cc, Pc, Likes, Favs, Tcs, Pcs int64 }
		if err := e.svc.DB.Raw(`SELECT t.like_count AS lc, t.fav_count AS fc, t.comment_count AS cc, p.comment_count AS pc,
  (SELECT COUNT(*) FROM likes WHERE trip_id = t.id) AS likes,
  (SELECT COUNT(*) FROM favorites WHERE trip_id = t.id) AS favs,
  (SELECT COUNT(*) FROM comments WHERE trip_id = t.id AND NOT deleted) AS tcs,
  (SELECT COUNT(*) FROM comments WHERE place_id = p.id AND NOT deleted) AS pcs
FROM trips t, places p WHERE t.id = ? AND p.id = ?`, tid, pid).Scan(&r).Error; err != nil {
			t.Fatal(err)
		}
		if r.Lc != r.Likes || r.Fc != r.Favs || r.Cc != r.Tcs || r.Pc != r.Pcs ||
			r.Likes != likes || r.Favs != favs || r.Tcs != comments || r.Pcs != placeComments {
			t.Fatalf("%s: %+v", step, r)
		}
	}
	for round := 0; round < 20; round++ {
		e.parallelOK(2, func(i int) (string, string, string, any) { return "POST", trip + "/like", toks[1+i], nil })
		check("2 likes", 2, 0, 0, 0)
		e.parallelOK(2, func(i int) (string, string, string, any) { return "DELETE", trip + "/like", toks[1+i], nil })
		check("2 unlikes", 0, 0, 0, 0)
	}
	e.parallelOK(n, func(i int) (string, string, string, any) { return "POST", trip + "/like", toks[i], nil })
	e.parallelOK(n, func(i int) (string, string, string, any) { return "POST", trip + "/favorite", toks[i], nil })
	check("likes and favorites", n, n, 0, 0)
	e.parallelOK(n, func(i int) (string, string, string, any) {
		return "POST", trip + "/comments", toks[i], map[string]any{"content": fmt.Sprintf("评论 %d", i)}
	})
	check("comments", n, n, n, 0)
	var cids []int64
	e.svc.DB.Raw("SELECT id FROM comments WHERE trip_id = ? ORDER BY id", tid).Scan(&cids)
	if len(cids) != n {
		t.Fatalf("comments: %v", cids)
	}
	e.parallelOK(n, func(i int) (string, string, string, any) {
		return "DELETE", fmt.Sprintf("/comments/%d", cids[i]), owner, nil
	})
	check("deleted comments", n, n, 0, 0)
	e.parallelOK(n, func(i int) (string, string, string, any) {
		return "POST", fmt.Sprintf("/places/%d/comments", pid), toks[i], map[string]any{"content": fmt.Sprintf("地点评论 %d", i)}
	})
	check("place comments", n, n, 0, n)
}

func TestExpDailyCap(t *testing.T) {
	e := setup(t)
	tok, _, _ := e.register("farmer")
	exp := func(tok string) (float64, float64) {
		m := e.must(200, "GET", "/me", tok, nil).obj(t)
		return num(m["exp"]), num(m["level"])
	}
	tid := id(e.must(200, "POST", "/trips", tok, map[string]any{"title": "刷经验"}).obj(t))
	wps := make([]any, 200)
	for i := range wps {
		wps[i] = map[string]any{"name": fmt.Sprintf("点%d", i), "lng": 120.1 + float64(i)*0.001, "lat": 30.2}
	}
	e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints/batch", tid), tok, map[string]any{"items": wps})
	if x, l := exp(tok); x != 100 || l != 2 {
		t.Fatalf("after 200 waypoints: exp=%v level=%v", x, l)
	}
	for i := 0; i < 5; i++ {
		pt := id(e.must(200, "POST", "/trips", tok, map[string]any{"title": "公开", "visibility": "public"}).obj(t))
		e.must(200, "DELETE", fmt.Sprintf("/trips/%d", pt), tok, nil)
	}
	if x, _ := exp(tok); x != 100 {
		t.Fatalf("create/delete loop: exp=%v", x)
	}
	// Being featured is not capped.
	e.must(200, "PATCH", fmt.Sprintf("/trips/%d", tid), tok, map[string]any{"visibility": "public"})
	e.must(200, "PATCH", fmt.Sprintf("/admin/trips/%d", tid), e.adminToken(), map[string]any{"featured": true})
	if x, _ := exp(tok); x != 150 {
		t.Fatalf("featured: exp=%v", x)
	}
	if s := e.must(200, "GET", "/site", "", nil).obj(t); num(s["exp_daily_cap"]) != 100 {
		t.Fatalf("site: %v", s["exp_daily_cap"])
	}
	// Concurrent requests cannot exceed the cap either.
	tok2, _, _ := e.register("farmer2")
	trips := make([]int64, 6)
	for i := range trips {
		trips[i] = id(e.must(200, "POST", "/trips", tok2, map[string]any{"title": fmt.Sprintf("并发 %d", i)}).obj(t))
	}
	e.parallelOK(len(trips), func(i int) (string, string, string, any) {
		items := make([]any, 50)
		for j := range items {
			items[j] = map[string]any{"name": fmt.Sprintf("点%d-%d", i, j), "lng": 120.1 + float64(j)*0.001, "lat": 30.3 + float64(i)*0.01}
		}
		return "POST", fmt.Sprintf("/trips/%d/waypoints/batch", trips[i]), tok2, map[string]any{"items": items}
	})
	if x, _ := exp(tok2); x != 100 {
		t.Fatalf("concurrent batches: exp=%v", x)
	}
}

func TestPlaceVisibility(t *testing.T) {
	e := setup(t)
	alice, _, _ := e.register("alice")
	bob, _, _ := e.register("bob")
	// A public 攻略 (planning trip): its stops are todo, nobody has checked in there yet.
	pub := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "杭州攻略", "visibility": "public"}).obj(t))
	w := e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints", pub), alice, map[string]any{"name": "知味观", "lng": 120.165, "lat": 30.255}).obj(t)
	pp := int64(num(w["place_id"]))
	if w["status"] != "todo" || pp == 0 {
		t.Fatalf("planned stop: %v", w)
	}
	e.must(200, "GET", fmt.Sprintf("/places/%d", pp), "", nil)
	e.must(200, "GET", fmt.Sprintf("/places/%d/reviews", pp), "", nil)
	e.must(200, "POST", fmt.Sprintf("/places/%d/comments", pp), bob, map[string]any{"content": "小笼包好吃"})
	if d := e.must(200, "GET", fmt.Sprintf("/trips/%d", pub), "", nil).obj(t); int64(num(d["waypoints"].([]any)[0].(map[string]any)["place_id"])) != pp {
		t.Fatalf("public trip place link: %v", d["waypoints"])
	}
	// A place only a private trip uses stays hidden from others.
	priv := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "私人"}).obj(t))
	pw := e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints", priv), alice, map[string]any{"name": "我家楼下", "lng": 120.10, "lat": 30.28}).obj(t)
	hp := int64(num(pw["place_id"]))
	e.must(404, "GET", fmt.Sprintf("/places/%d", hp), "", nil)
	e.must(404, "GET", fmt.Sprintf("/places/%d", hp), bob, nil)
	e.must(200, "GET", fmt.Sprintf("/places/%d", hp), alice, nil)
	e.must(200, "GET", fmt.Sprintf("/places/%d", hp), e.adminToken(), nil)
	// Invited co-authors may open it before accepting.
	e.must(200, "POST", fmt.Sprintf("/trips/%d/members", priv), alice, map[string]any{"username": "bob"})
	e.must(200, "GET", fmt.Sprintf("/places/%d", hp), bob, nil)
	// Share-code visitors of an unlisted trip get no link to such a place, but keep links to public ones.
	e.must(200, "PATCH", fmt.Sprintf("/trips/%d", priv), alice, map[string]any{"visibility": "unlisted"})
	e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints", priv), alice, map[string]any{"name": "知味观", "lng": 120.1651, "lat": 30.2551})
	code := e.must(200, "GET", fmt.Sprintf("/trips/%d", priv), alice, nil).obj(t)["share_code"].(string)
	shared := e.must(200, "GET", "/share/"+code, "", nil).obj(t)["waypoints"].([]any)
	if len(shared) != 2 || shared[0].(map[string]any)["place_id"] != nil || int64(num(shared[1].(map[string]any)["place_id"])) != pp {
		t.Fatalf("shared trip place links: %v", shared)
	}
	if own := e.must(200, "GET", fmt.Sprintf("/trips/%d", priv), alice, nil).obj(t)["waypoints"].([]any); int64(num(own[0].(map[string]any)["place_id"])) != hp {
		t.Fatalf("members keep all links: %v", own)
	}
}

func TestPhotoMarksPlannedStop(t *testing.T) {
	e := setup(t)
	alice, _, _ := e.register("alice")
	tid := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "西湖", "phase": "ongoing"}).obj(t))
	stop := e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints", tid), alice, map[string]any{
		"name": "断桥残雪", "lng": 120.1500, "lat": 30.2600, "planned": true}).obj(t)
	upload := func(dx float64) map[string]any {
		lng, lat := geo.GCJ02ToWGS84(120.1500+dx, 30.2600)
		r := e.upload(fmt.Sprintf("/trips/%d/photos", tid), alice, testJPEG(t, 300, 200), map[string]string{
			"lng": fmt.Sprint(lng), "lat": fmt.Sprint(lat), "taken_at": "2026-05-01T09:30:00+08:00", "auto_waypoint": "true"})
		if r.status != 200 {
			t.Fatalf("upload: %d %s", r.status, r.body)
		}
		return r.obj(t)["waypoint"].(map[string]any)
	}
	// ~200 m before the stop: linked to it, but not proof of arrival.
	if w := upload(0.00208); id(w) != id(stop) || w["status"] != "todo" {
		t.Fatalf("photo 200 m away: %v", w)
	}
	// ~50 m away: the stop is visited at the time the photo was taken.
	if w := upload(0.00052); id(w) != id(stop) || w["status"] != "visited" || w["arrived_at"] != "2026-05-01T09:30:00+08:00" {
		t.Fatalf("photo 50 m away: %v", w)
	}
}

// A GPS track that covers only part of a trip must not replace the distance
// of its check-in route; a track longer than the route wins.
func TestTripDistance(t *testing.T) {
	e := setup(t)
	alice, _, _ := e.register("alice")
	trip := fmt.Sprintf("/trips/%d", id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "长三角", "phase": "ongoing"}).obj(t)))
	e.must(200, "POST", trip+"/waypoints/batch", alice, map[string]any{"items": []any{
		map[string]any{"name": "断桥残雪", "lng": 120.1513, "lat": 30.2610, "arrived_at": "2026-05-01T09:00:00+08:00"},
		map[string]any{"name": "拙政园", "lng": 120.6270, "lat": 31.3240, "arrived_at": "2026-05-02T10:00:00+08:00"},
	}})
	km := func(path string) float64 { return num(e.must(200, "GET", path, alice, nil).obj(t)["distance_km"]) }
	route := km(trip)
	if route < 100 {
		t.Fatalf("check-in route: %v km", route)
	}
	base := time.Date(2026, 5, 1, 1, 30, 0, 0, time.UTC).UnixMilli()
	walk := []map[string]any{}
	for i := 0; i < 20; i++ {
		walk = append(walk, map[string]any{"lng": 120.15 + float64(i)*0.0005, "lat": 30.26, "t": base + int64(i)*10000})
	}
	// A walk recorded on day 1, then a stray point in another segment.
	if r := e.must(200, "POST", trip+"/track", alice, map[string]any{"points": walk}).obj(t); num(r["distance_km"]) < 0.8 || num(r["distance_km"]) > 1 {
		t.Fatalf("walk: %v", r)
	}
	if got := km(trip); got != route {
		t.Fatalf("a partial track changed the trip distance: %v km, check-in route %v km", got, route)
	}
	e.must(200, "POST", trip+"/track", alice, map[string]any{"segment": 7, "points": []any{
		map[string]any{"lng": 120.6, "lat": 31.3, "t": base + 86400000}}})
	if got := km(trip); got != route {
		t.Fatalf("a stray track point changed the trip distance: %v km, check-in route %v km", got, route)
	}
	// A track longer than the check-in route is the trip's distance.
	zigzag := []any{}
	for i := 0; i < 4; i++ {
		zigzag = append(zigzag, map[string]any{"lng": 120.0 + float64(i%2), "lat": 30.5, "t": base + 2*86400000 + int64(i)*600000})
	}
	long := num(e.must(200, "POST", trip+"/track", alice, map[string]any{"segment": 8, "points": zigzag}).obj(t)["distance_km"])
	if got := km(trip); long < route || math.Abs(got-long) > 0.1 {
		t.Fatalf("full-trip track: trip %v km, track %v km, check-in route %v km", got, long, route)
	}
	e.must(200, "DELETE", trip+"/track", alice, nil)
	if got := km(trip); got != route {
		t.Fatalf("after clearing the track: %v km, check-in route %v km", got, route)
	}
	// Before any check-in the track is the distance, without one the planned route.
	plan := fmt.Sprintf("/trips/%d", id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "计划"}).obj(t)))
	e.must(200, "POST", plan+"/waypoints/batch", alice, map[string]any{"items": []any{
		map[string]any{"name": "断桥残雪", "lng": 120.1513, "lat": 30.2610},
		map[string]any{"name": "拙政园", "lng": 120.6270, "lat": 31.3240},
	}})
	if got := km(plan); got != route {
		t.Fatalf("planned route: %v km, want %v", got, route)
	}
	walked := num(e.must(200, "POST", plan+"/track", alice, map[string]any{"points": walk}).obj(t)["distance_km"])
	if got := km(plan); math.Abs(got-walked) > 0.1 {
		t.Fatalf("track without check-ins: trip %v km, track %v km", got, walked)
	}
}

// loadUsers reads only what UserBriefs show: no password hashes or e-mail
// addresses of other users on public lists.
func TestLoadUsersBrief(t *testing.T) {
	e := setup(t)
	_, _, aliceID := e.register("alice")
	users, err := New(e.svc, nil).loadUsers(context.Background(), []int64{aliceID, aliceID, 0})
	if err != nil {
		t.Fatal(err)
	}
	u := users[aliceID]
	if len(users) != 1 || u == nil || u.ID != aliceID || u.Username != "alice" || u.Role != "user" || u.PasswordHash != "" || u.Email != "" {
		t.Fatalf("loadUsers: %+v", users)
	}
}

// Legs between the planned stops of each day: estimated from the straight
// line when 高德 is not configured, for logged-in viewers of the trip only.
func TestTripLegs(t *testing.T) {
	e := setup(t)
	alice, _, _ := e.register("alice")
	bob, _, _ := e.register("bob")
	tripID := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "杭州两日"}).obj(t))
	stops := e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints/batch", tripID), alice, map[string]any{"items": []any{
		map[string]any{"name": "断桥残雪", "lng": 120.1513, "lat": 30.2610, "day": 1},
		map[string]any{"name": "楼外楼", "lng": 120.1437, "lat": 30.2556, "day": 1},
		map[string]any{"name": "路边小店", "lng": 120.1450, "lat": 30.2450, "day": 1, "planned": false},
		map[string]any{"name": "雷峰塔", "lng": 120.1488, "lat": 30.2317, "day": 1},
		map[string]any{"name": "灵隐寺", "lng": 120.1016, "lat": 30.2408, "day": 2},
		map[string]any{"name": "河坊街", "lng": 120.1690, "lat": 30.2420, "day": 2},
		map[string]any{"name": "待定", "lng": 120.2000, "lat": 30.3000},
	}}).arr(t)
	sid := func(i int) int64 { return id(stops[i].(map[string]any)) }
	path := fmt.Sprintf("/trips/%d/legs", tripID)
	e.must(401, "GET", path, "", nil)
	e.must(404, "GET", path, bob, nil) // private trip
	e.must(400, "GET", path+"?mode=cycling", alice, nil)

	for _, mode := range []string{"", "walking", "transit", "driving"} {
		q := path
		if mode != "" {
			q += "?mode=" + mode
		} else {
			mode = "transit"
		}
		res := e.must(200, "GET", q, alice, nil).obj(t)
		if res["mode"] != mode {
			t.Fatalf("mode %v, want %s", res["mode"], mode)
		}
		legs := res["legs"].([]any)
		want := [][3]int64{{sid(0), sid(1), 1}, {sid(1), sid(3), 1}, {sid(4), sid(5), 2}} // not across days nor via unplanned stops
		if len(legs) != len(want) {
			t.Fatalf("%s: legs %v", mode, legs)
		}
		daySum := map[int][2]float64{}
		for i, l := range legs {
			m := l.(map[string]any)
			if int64(num(m["from_id"])) != want[i][0] || int64(num(m["to_id"])) != want[i][1] || int64(num(m["day"])) != want[i][2] ||
				m["estimated"] != true || num(m["distance_m"]) < num(m["straight_m"]) || num(m["duration_s"]) <= 0 {
				t.Fatalf("%s: leg %d: %v", mode, i, m)
			}
			legMode := mode
			if mode == "transit" && i == 0 { // under 1 km: walked
				legMode = "walking"
			}
			if m["mode"] != legMode {
				t.Fatalf("%s: leg %d mode %v", mode, i, m["mode"])
			}
			d := int(num(m["day"]))
			daySum[d] = [2]float64{daySum[d][0] + num(m["distance_m"]), daySum[d][1] + num(m["duration_s"])}
		}
		days := res["days"].([]any)
		wantDays := [][2]int{{1, 3}, {2, 2}, {0, 1}} // day, stops (未分天 last)
		if len(days) != len(wantDays) {
			t.Fatalf("%s: days %v", mode, days)
		}
		for i, d := range days {
			m := d.(map[string]any)
			day := int(num(m["day"]))
			if day != wantDays[i][0] || int(num(m["stops"])) != wantDays[i][1] ||
				num(m["distance_m"]) != daySum[day][0] || num(m["duration_s"]) != daySum[day][1] || m["estimated"] != (day != 0) {
				t.Fatalf("%s: day %d: %v (legs sum %v)", mode, i, m, daySum[day])
			}
		}
	}
	e.must(200, "PATCH", fmt.Sprintf("/trips/%d", tripID), alice, map[string]any{"visibility": "public"})
	e.must(200, "GET", path+"?mode=walking", bob, nil)
}

// Handlers that change a waypoint's status, photos or position take the trip
// lock, so concurrent changes neither leave stale statistics nor undo each other.
func TestConcurrentWaypointChanges(t *testing.T) {
	e := setup(t)
	var slowRegeo sync.Map // "on" → reverse geocoding takes 800 ms
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, on := slowRegeo.Load("on"); on && r.URL.Path == "/v3/geocode/regeo" {
			time.Sleep(800 * time.Millisecond)
		}
		_, _ = w.Write([]byte(`{"status":"1","count":"0","infocode":"10000","pois":[],"regeocode":{"formatted_address":[],"addressComponent":{}}}`))
	}))
	t.Cleanup(srv.Close)
	am := amap.New("test-key")
	am.SetBaseURL(srv.URL)
	e.svc.Amap = am // before any request
	alice, _, _ := e.register("alice")
	tid := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "并发", "phase": "ongoing"}).obj(t))
	wps := e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints/batch", tid), alice, map[string]any{"items": []any{
		map[string]any{"name": "甲", "lng": 120.15, "lat": 30.26, "planned": true},
		map[string]any{"name": "乙", "lng": 120.16, "lat": 30.26, "planned": true},
	}}).arr(t)
	w1, w2 := id(wps[0].(map[string]any)), id(wps[1].(map[string]any))
	check := func(step string) {
		t.Helper()
		var r struct{ Stored, Visited int64 }
		e.svc.DB.Raw(`SELECT visited_count AS stored, (SELECT COUNT(*) FROM waypoints WHERE trip_id = trips.id AND status = 'visited') AS visited
FROM trips WHERE id = ?`, tid).Scan(&r)
		if r.Stored != r.Visited {
			t.Fatalf("%s: visited_count %d, visited waypoints %d", step, r.Stored, r.Visited)
		}
	}
	for round := 0; round < 10; round++ {
		e.parallelOK(2, func(i int) (string, string, string, any) {
			if i == 0 {
				return "POST", fmt.Sprintf("/trips/%d/checkin", tid), alice, map[string]any{"waypoint_id": w1}
			}
			return "POST", fmt.Sprintf("/waypoints/%d/skip", w2), alice, nil
		})
		check(fmt.Sprintf("round %d: check-in and skip", round))
		e.parallelOK(2, func(i int) (string, string, string, any) {
			return "POST", fmt.Sprintf("/waypoints/%d/reset", []int64{w1, w2}[i]), alice, nil
		})
		check(fmt.Sprintf("round %d: two resets", round))
		e.parallelOK(2, func(i int) (string, string, string, any) {
			return "POST", fmt.Sprintf("/waypoints/%d/checkin", []int64{w1, w2}[i]), alice, map[string]any{}
		})
		check(fmt.Sprintf("round %d: two check-ins", round))
		e.parallelOK(2, func(i int) (string, string, string, any) {
			return "POST", fmt.Sprintf("/waypoints/%d/reset", []int64{w1, w2}[i]), alice, nil
		})
	}
	// Moving a stop (reverse geocoding takes a while) does not undo a check-in made meanwhile.
	slowRegeo.Store("on", true)
	done := make(chan int)
	go func() {
		done <- e.status("PATCH", fmt.Sprintf("/waypoints/%d", w1), alice, map[string]any{"lng": 120.151, "lat": 30.261})
	}()
	time.Sleep(200 * time.Millisecond)
	e.must(200, "POST", fmt.Sprintf("/trips/%d/checkin", tid), alice, map[string]any{"waypoint_id": w1})
	if code := <-done; code != 200 {
		t.Fatalf("PATCH: %d", code)
	}
	slowRegeo.Delete("on")
	moved := e.must(200, "GET", fmt.Sprintf("/trips/%d", tid), alice, nil).obj(t)["waypoints"].([]any)[0].(map[string]any)
	if moved["status"] != "visited" || moved["arrived_at"] == nil || num(moved["lng"]) != 120.151 {
		t.Fatalf("check-in undone by a concurrent edit: %v", moved)
	}
	check("edit and check-in")
	// Deleting a photo twice at once releases its storage once.
	storage := func() float64 { return num(e.must(200, "GET", "/me", alice, nil).obj(t)["storage_used"]) }
	upload := func() int64 {
		r := e.upload(fmt.Sprintf("/trips/%d/photos", tid), alice, testJPEG(t, 300, 200), nil)
		if r.status != 200 {
			t.Fatalf("upload: %d %s", r.status, r.body)
		}
		return id(r.obj(t)["photo"].(map[string]any))
	}
	upload()
	kept := storage()
	for round := 0; round < 5; round++ {
		p2 := upload()
		codes := make([]int, 2)
		parallel(2, func(i int) { codes[i] = e.status("DELETE", fmt.Sprintf("/photos/%d", p2), alice, nil) })
		if codes[0]+codes[1] != 200+404 {
			t.Fatalf("round %d: double delete: %v", round, codes)
		}
		if s := storage(); s != kept {
			t.Fatalf("round %d: storage after a double delete: %v, want %v", round, s, kept)
		}
	}
}

// Sensitive words (屏蔽词), the review of public trips and the /uploads/-only
// image rule; all are off / empty by default.
func TestContentSafety(t *testing.T) {
	e := setup(t)
	alice, _, _ := e.register("alice")
	bob, _, _ := e.register("bob")
	admin := e.adminToken()
	e.must(200, "PUT", "/admin/settings", admin, map[string]any{"sensitive_words": "博彩\n代开发票"})
	if s := e.must(200, "GET", "/admin/settings", admin, nil).obj(t); s["sensitive_words"] != "博彩\n代开发票" || s["review_public_trips"] != false {
		t.Fatalf("settings: %v", s)
	}
	if s := e.must(200, "GET", "/site", "", nil).obj(t); s["sensitive_words"] != nil {
		t.Fatalf("the word list must not be public: %v", s)
	}
	r := e.must(400, "POST", "/trips", alice, map[string]any{"title": "杭州 博 彩 攻略"}).obj(t)
	if msg := r["error"].(map[string]any)["message"]; msg != "内容包含不允许发布的词语「博彩」，请修改后再提交" {
		t.Fatalf("message: %v", msg)
	}
	tid := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "杭州三日", "visibility": "public"}).obj(t))
	trip := fmt.Sprintf("/trips/%d", tid)
	e.must(400, "PATCH", trip, alice, map[string]any{"tags": []string{"美食", "代开发票"}})
	e.must(400, "PATCH", trip, alice, map[string]any{"content": "## 第一天\n\n楼下有**博彩**广告"})
	e.must(400, "POST", trip+"/comments", bob, map[string]any{"content": "需要代开 发票请联系"})
	e.must(200, "POST", trip+"/comments", bob, map[string]any{"content": "好玩"})
	e.must(400, "POST", trip+"/waypoints/batch", alice, map[string]any{"items": []any{
		map[string]any{"name": "断桥", "lng": 120.15, "lat": 30.26},
		map[string]any{"name": "某店", "note": "可以代开发票", "lng": 120.16, "lat": 30.26},
	}})
	e.must(400, "PATCH", "/me", bob, map[string]any{"bio": "专业博彩"})
	e.must(400, "POST", "/partner/invites", bob, map[string]any{"username": "alice", "message": "一起去博彩"})
	e.must(400, "POST", "/auth/register", "", map[string]any{"username": "carol", "nickname": "博彩代理", "password": "secret123", "agree_terms": true})
	e.must(200, "POST", "/trips", admin, map[string]any{"title": "关于博彩广告的处理公告"}) // admins are not screened
	// Images must have been uploaded to this site.
	e.must(400, "PATCH", trip, alice, map[string]any{"cover_url": "https://tracker.example.com/pixel.png"})
	e.must(400, "PATCH", "/me", alice, map[string]any{"avatar_url": "/uploads/../api/v1/me"})
	e.must(200, "PATCH", trip, alice, map[string]any{"cover_url": "/uploads/2026/09/cover.jpg"})

	// With review on, a trip a user makes public is shown once an admin approves it.
	e.must(200, "PUT", "/admin/settings", admin, map[string]any{"review_public_trips": true})
	listed := func(tripID int64) bool {
		for _, it := range items(t, e.must(200, "GET", "/trips", "", nil)) {
			if id(it.(map[string]any)) == tripID {
				return true
			}
		}
		return false
	}
	status := func(tripID int64) any {
		return e.must(200, "GET", fmt.Sprintf("/trips/%d", tripID), admin, nil).obj(t)["status"]
	}
	pending := e.must(200, "POST", "/trips", bob, map[string]any{"title": "待审核", "visibility": "public"}).obj(t)
	pid := id(pending)
	if pending["status"] != "pending" || listed(pid) || !listed(tid) {
		t.Fatalf("pending trip: status %v, listed %v; earlier public trip listed %v", pending["status"], listed(pid), listed(tid))
	}
	e.must(404, "GET", fmt.Sprintf("/trips/%d", pid), "", nil)
	e.must(404, "GET", fmt.Sprintf("/trips/%d", pid), alice, nil)
	e.must(200, "GET", fmt.Sprintf("/trips/%d", pid), bob, nil)
	e.must(200, "PATCH", trip, alice, map[string]any{"title": "杭州三日游"}) // editing a public trip needs no new review
	if s := status(tid); s != "normal" {
		t.Fatalf("edited public trip: %v", s)
	}
	// A trip made public later waits too, and leaves the queue when it is no longer public.
	later := id(e.must(200, "POST", "/trips", bob, map[string]any{"title": "以后公开"}).obj(t))
	e.must(200, "PATCH", fmt.Sprintf("/trips/%d", later), bob, map[string]any{"visibility": "public"})
	if s := status(later); s != "pending" {
		t.Fatalf("trip made public: %v", s)
	}
	e.must(200, "PATCH", fmt.Sprintf("/trips/%d", later), bob, map[string]any{"visibility": "unlisted"})
	if s := status(later); s != "normal" {
		t.Fatalf("trip no longer public: %v", s)
	}
	if st := e.must(200, "GET", "/admin/stats", admin, nil).obj(t); num(st["pending_trips"]) != 1 {
		t.Fatalf("pending_trips: %v", st["pending_trips"])
	}
	if q := items(t, e.must(200, "GET", "/admin/trips?status=pending", admin, nil)); len(q) != 1 || id(q[0].(map[string]any)) != pid {
		t.Fatalf("review queue: %v", q)
	}
	e.must(200, "PATCH", fmt.Sprintf("/admin/trips/%d", pid), admin, map[string]any{"status": "normal"})
	if !listed(pid) {
		t.Fatal("approved trip not listed")
	}
	e.must(200, "GET", fmt.Sprintf("/trips/%d", pid), "", nil)
	// Rejected (hidden) trips stay hidden whatever their author does.
	rej := id(e.must(200, "POST", "/trips", bob, map[string]any{"title": "被驳回", "visibility": "public"}).obj(t))
	e.must(200, "PATCH", fmt.Sprintf("/admin/trips/%d", rej), admin, map[string]any{"status": "hidden"})
	for _, vis := range []string{"private", "public"} {
		e.must(200, "PATCH", fmt.Sprintf("/trips/%d", rej), bob, map[string]any{"visibility": vis})
	}
	if s := status(rej); s != "hidden" || listed(rej) {
		t.Fatalf("rejected trip: %v", s)
	}
	verdicts := map[string]bool{}
	for _, n := range items(t, e.must(200, "GET", "/notifications", bob, nil)) {
		verdicts[n.(map[string]any)["content"].(string)] = true
	}
	if !verdicts["你的旅程「待审核」已通过审核，现已公开"] || !verdicts["你的旅程「被驳回」未通过审核"] {
		t.Fatalf("review notifications: %v", verdicts)
	}
	// Admins' public trips need no review.
	if d := e.must(200, "POST", "/trips", admin, map[string]any{"title": "站务", "visibility": "public"}).obj(t); d["status"] != "normal" {
		t.Fatalf("admin trip: %v", d["status"])
	}
}

// An unplanned check-in goes right after the end of the actual route, also
// when visited stops have no arrival time (marked 已打卡 in the editor).
func TestCheckinAfterUntimedVisits(t *testing.T) {
	e := setup(t)
	alice, _, _ := e.register("alice")
	for _, firstTimed := range []bool{false, true} {
		trip := fmt.Sprintf("/trips/%d", id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "按图打卡"}).obj(t)))
		items := []any{}
		for i := 0; i < 4; i++ {
			items = append(items, map[string]any{"name": fmt.Sprintf("Q%d", i+1), "lng": 120.10 + float64(i)*0.01, "lat": 30.25})
		}
		stops := e.must(200, "POST", trip+"/waypoints/batch", alice, map[string]any{"items": items}).arr(t)
		e.must(200, "PATCH", trip, alice, map[string]any{"phase": "ongoing"})
		for i, s := range stops[:3] {
			path := fmt.Sprintf("/waypoints/%d", id(s.(map[string]any)))
			if i == 0 && firstTimed {
				e.must(200, "POST", path+"/checkin", alice, map[string]any{})
			} else {
				e.must(200, "PATCH", path, alice, map[string]any{"status": "visited", "arrived_at": nil})
			}
		}
		for n := 1; n <= 2; n++ { // far from every stop
			ci := e.must(200, "POST", trip+"/checkin", alice, map[string]any{"lng": 120.20 + float64(n)*0.01, "lat": 30.30,
				"name": fmt.Sprintf("新点%d", n)}).obj(t)
			if w := ci["waypoint"].(map[string]any); ci["matched_plan"] != false || int(num(w["seq"])) != 2+n {
				t.Fatalf("first stop timed %v, check-in %d: %v", firstTimed, n, ci)
			}
		}
		var names []string
		for _, w := range e.must(200, "GET", trip, alice, nil).obj(t)["waypoints"].([]any) {
			names = append(names, w.(map[string]any)["name"].(string))
		}
		if got := strings.Join(names, ","); got != "Q1,Q2,Q3,新点1,新点2,Q4" {
			t.Fatalf("first stop timed %v: order %s", firstTimed, got)
		}
	}
}

// Accepting and withdrawing / declining an invite at the same moment has one
// winner: a withdrawn invite never binds the couple, an accepted one stays accepted.
func TestPartnerInviteRace(t *testing.T) {
	e := setup(t)
	alice, _, aliceID := e.register("alice")
	bob, _, bobID := e.register("bob")
	inviteStatus := func(inv int64) string {
		var s string
		e.svc.DB.Raw("SELECT status FROM partner_invites WHERE id = ?", inv).Scan(&s)
		return s
	}
	// waitLock waits until a request is blocked on a row lock.
	waitLock := func() {
		t.Helper()
		for i := 0; i < 250; i++ {
			var n int64
			e.svc.DB.Raw("SELECT COUNT(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'").Scan(&n)
			if n > 0 {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatal("the request never waited for the lock")
	}

	// Bob accepts while the users are locked; alice withdraws meanwhile.
	inv := id(e.must(200, "POST", "/partner/invites", alice, map[string]any{"username": "bob"}).obj(t))
	blocker := e.svc.DB.Begin()
	if err := blocker.Exec("SELECT id FROM users WHERE id IN (?, ?) FOR UPDATE", aliceID, bobID).Error; err != nil {
		t.Fatal(err)
	}
	done := make(chan int, 1)
	go func() { done <- e.status("POST", fmt.Sprintf("/partner/invites/%d/accept", inv), bob, nil) }()
	waitLock()
	e.must(200, "DELETE", fmt.Sprintf("/partner/invites/%d", inv), alice, nil)
	if err := blocker.Commit().Error; err != nil {
		t.Fatal(err)
	}
	if code := <-done; code != 404 {
		t.Fatalf("accepting a withdrawn invite: %d", code)
	}
	if p := e.must(200, "GET", "/partner", alice, nil).obj(t); p["partner"] != nil || inviteStatus(inv) != "canceled" {
		t.Fatalf("withdrawn invite: partner %v, status %s", p["partner"], inviteStatus(inv))
	}
	for _, n := range items(t, e.must(200, "GET", "/notifications", alice, nil)) {
		if n.(map[string]any)["type"] == "partner_accept" {
			t.Fatalf("notified of a lost accept: %v", n)
		}
	}

	// An accept commits while the withdrawal waits for the invite's row: the withdrawal loses.
	inv2 := id(e.must(200, "POST", "/partner/invites", alice, map[string]any{"username": "bob"}).obj(t))
	blocker = e.svc.DB.Begin()
	if err := blocker.Exec("UPDATE partner_invites SET status = 'accepted' WHERE id = ?", inv2).Error; err != nil {
		t.Fatal(err)
	}
	go func() { done <- e.status("DELETE", fmt.Sprintf("/partner/invites/%d", inv2), alice, nil) }()
	waitLock()
	if err := blocker.Commit().Error; err != nil {
		t.Fatal(err)
	}
	if code := <-done; code != 404 || inviteStatus(inv2) != "accepted" {
		t.Fatalf("withdrawing an accepted invite: %d, status %s", code, inviteStatus(inv2))
	}
	e.must(404, "POST", fmt.Sprintf("/partner/invites/%d/decline", inv2), bob, nil)
}

// A stop dragged far away is another place: it loses its AMap POI link and
// the old address; a small adjustment (e.g. to the entrance) keeps both.
func TestWaypointRelocation(t *testing.T) {
	e := setup(t)
	srv := fakeAmap(t)
	t.Cleanup(srv.Close)
	am := amap.New("test-key")
	am.SetBaseURL(srv.URL)
	e.svc.Amap = am // before any request
	alice, _, _ := e.register("alice")
	tid := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "杭州", "visibility": "public", "phase": "finished"}).obj(t))
	w := e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints", tid), alice, map[string]any{
		"name": "楼外楼", "address": "孤山路30号", "lng": 120.1438, "lat": 30.2557, "amap_id": "B023B0J1V1"}).obj(t)
	path := fmt.Sprintf("/waypoints/%d", id(w))
	pid := w["place_id"]
	if p := e.must(200, "GET", fmt.Sprintf("/places/%d", int64(num(pid))), "", nil).obj(t); p["amap_id"] != "B023B0J1V1" {
		t.Fatalf("POI place: %v", p)
	}
	if near := e.must(200, "PATCH", path, alice, map[string]any{"lng": 120.1442, "lat": 30.2557}).obj(t); near["amap_id"] != "B023B0J1V1" ||
		near["address"] != "孤山路30号" || near["place_id"] != pid {
		t.Fatalf("moved 40 m: %v", near)
	}
	far := e.must(200, "PATCH", path, alice, map[string]any{"lng": 120.1540, "lat": 30.2557}).obj(t)
	if far["amap_id"] != "" || far["address"] != "" || far["place_id"] == nil || far["place_id"] == pid {
		t.Fatalf("moved 1 km: %v", far)
	}
	if p := e.must(200, "GET", fmt.Sprintf("/places/%d", int64(num(pid))), "", nil).obj(t); num(p["checkin_count"]) != 0 {
		t.Fatalf("the POI place still counts the moved stop: %v", p)
	}
	// An amap_id and address sent with the move are kept.
	back := e.must(200, "PATCH", path, alice, map[string]any{"lng": 120.1438, "lat": 30.2557, "amap_id": "B023B0J1V1", "address": "孤山路30号"}).obj(t)
	if back["amap_id"] != "B023B0J1V1" || back["address"] != "孤山路30号" || back["place_id"] != pid {
		t.Fatalf("moved back with the POI: %v", back)
	}
}

// Batch items with a seq land where sequential single creates would put them.
func TestBatchWaypointPositions(t *testing.T) {
	e := setup(t)
	alice, _, _ := e.register("alice")
	trip := fmt.Sprintf("/trips/%d", id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "顺序"}).obj(t)))
	stop := func(name string, seq any) map[string]any {
		m := map[string]any{"name": name, "lng": 120.10 + float64(name[0]-'A')*0.001, "lat": 30.25}
		if seq != nil {
			m["seq"] = seq
		}
		return m
	}
	batch := func(want string, items ...any) {
		t.Helper()
		saved := e.must(200, "POST", trip+"/waypoints/batch", alice, map[string]any{"items": items}).arr(t)
		if len(saved) != len(items) {
			t.Fatalf("saved %d of %d", len(saved), len(items))
		}
		var names []string
		for i, w := range e.must(200, "GET", trip, alice, nil).obj(t)["waypoints"].([]any) {
			wm := w.(map[string]any)
			if int(num(wm["seq"])) != i {
				t.Fatalf("seq %v at position %d", wm["seq"], i)
			}
			names = append(names, wm["name"].(string))
		}
		if got := strings.Join(names, ","); got != want {
			t.Fatalf("order %s, want %s", got, want)
		}
	}
	batch("A,B,C", stop("A", nil), stop("B", nil), stop("C", nil))
	batch("X,A,Z,B,C,Y,W", stop("X", 0), stop("Y", nil), stop("Z", 2), stop("W", -1))
	// A seq at or past the end appends.
	batch("X,A,Z,B,C,Y,W,R,P,Q", stop("P", 7), stop("Q", 100), stop("R", 7))
}

// sqlLog records the statements run through a gorm session.
type sqlLog struct {
	mu    sync.Mutex
	stmts []string
}

func (l *sqlLog) LogMode(logger.LogLevel) logger.Interface { return l }
func (l *sqlLog) Info(context.Context, string, ...any)     {}
func (l *sqlLog) Warn(context.Context, string, ...any)     {}
func (l *sqlLog) Error(context.Context, string, ...any)    {}
func (l *sqlLog) Trace(_ context.Context, _ time.Time, fc func() (string, int64), _ error) {
	sql, _ := fc()
	l.mu.Lock()
	l.stmts = append(l.stmts, sql)
	l.mu.Unlock()
}

// Float columns that older versions created as numeric become double
// precision (keeping their values); later starts change nothing.
func TestFloatColumnMigration(t *testing.T) {
	e := setup(t)
	alice, _, _ := e.register("alice")
	trip := fmt.Sprintf("/trips/%d", id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "杭州"}).obj(t)))
	e.must(200, "POST", trip+"/waypoints", alice, map[string]any{"name": "断桥残雪", "lng": 120.1513, "lat": 30.2610, "cost": 12.5})
	gdb := e.svc.DB
	for _, s := range []string{ // the schema as an older version created it
		`ALTER TABLE waypoints ALTER COLUMN lng TYPE numeric, ALTER COLUMN lat TYPE numeric, ALTER COLUMN cost TYPE numeric`,
		`ALTER TABLE track_points ALTER COLUMN speed TYPE numeric`,
		`ALTER TABLE places ALTER COLUMN rating_avg TYPE numeric`,
	} {
		if err := gdb.Exec(s).Error; err != nil {
			t.Fatal(err)
		}
	}
	numeric := func() []string {
		var cols []string
		gdb.Raw(`SELECT table_name || '.' || column_name FROM information_schema.columns
WHERE table_schema = current_schema() AND data_type = 'numeric' ORDER BY 1`).Scan(&cols)
		return cols
	}
	if cols := numeric(); len(cols) != 5 {
		t.Fatalf("numeric columns before: %v", cols)
	}
	if err := db.Migrate(gdb); err != nil {
		t.Fatal(err)
	}
	if cols := numeric(); len(cols) != 0 {
		t.Fatalf("still numeric: %v", cols)
	}
	w := e.must(200, "GET", trip, alice, nil).obj(t)["waypoints"].([]any)[0].(map[string]any)
	if num(w["lng"]) != 120.1513 || num(w["lat"]) != 30.261 || num(w["cost"]) != 12.5 {
		t.Fatalf("values after the conversion: %v", w)
	}
	rec := &sqlLog{}
	if err := db.Migrate(gdb.Session(&gorm.Session{Logger: rec})); err != nil {
		t.Fatal(err)
	}
	for _, s := range rec.stmts {
		if strings.HasPrefix(strings.ToUpper(strings.TrimSpace(s)), "ALTER") {
			t.Errorf("second migration altered the schema: %s", s)
		}
	}
}

// Migrate on an up-to-date schema changes nothing: an ALTER there (such as
// GORM re-setting a column default it compares wrongly) takes an ACCESS
// EXCLUSIVE lock on every start, which waits behind a running pg_dump.
func TestMigrateIsIdempotent(t *testing.T) {
	dsn := os.Getenv("TRIPHUB_TEST_DSN")
	if dsn == "" {
		t.Skip("TRIPHUB_TEST_DSN not set; skipping integration test")
	}
	gdb, err := db.Open(context.Background(), dsn, 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if sqlDB, err := gdb.DB(); err == nil {
		t.Cleanup(func() { _ = sqlDB.Close() })
	}
	if err := gdb.Exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(gdb); err != nil {
		t.Fatal(err)
	}
	rec := &sqlLog{}
	if err := db.Migrate(gdb.Session(&gorm.Session{Logger: rec})); err != nil {
		t.Fatal(err)
	}
	for _, s := range rec.stmts {
		if strings.HasPrefix(strings.ToUpper(strings.TrimSpace(s)), "ALTER TABLE") {
			t.Errorf("second Migrate on an up-to-date schema issued: %s", s)
		}
	}
}
