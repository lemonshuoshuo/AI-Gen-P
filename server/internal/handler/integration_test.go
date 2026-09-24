package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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
	r := e.must(200, "POST", "/auth/register", "", map[string]any{"username": username, "password": "secret123", "email": username + "@example.com"})
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
	e.must(409, "POST", "/auth/register", "", map[string]any{"username": "ALICE", "password": "secret123"})
	e.must(400, "POST", "/auth/register", "", map[string]any{"username": "a!", "password": "secret123"})
	e.must(400, "POST", "/auth/register", "", map[string]any{"username": "carol", "password": "123"})
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
	pub := e.must(200, "PATCH", fmt.Sprintf("/trips/%d", tripID), alice, map[string]any{"visibility": "public", "phase": "ongoing"}).obj(t)
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
	if ci["matched_plan"] != true || id(ci["waypoint"].(map[string]any)) != wpIDs[0] {
		t.Fatalf("checkin should match 断桥: %v", ci)
	}
	extra := e.must(200, "POST", fmt.Sprintf("/trips/%d/checkin", tripID), alice, map[string]any{
		"lng": 120.1700, "lat": 30.2800, "name": "路边小吃"}).obj(t)
	if extra["matched_plan"] != false || extra["waypoint"].(map[string]any)["planned"] != false {
		t.Fatalf("extra checkin: %v", extra)
	}
	e.must(200, "POST", fmt.Sprintf("/waypoints/%d/checkin", wpIDs[1]), alice, map[string]any{})
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
	near := e.must(200, "GET", "/places/nearby?lng=120.1440&lat=30.2556&radius=500", "", nil).arr(t)
	if len(near) != 1 || near[0].(map[string]any)["distance_m"] == nil {
		t.Fatalf("nearby: %v", near)
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
	fk := e.must(200, "POST", fmt.Sprintf("/trips/%d/fork", tripID), bob, map[string]any{"title": "我也要去杭州"}).obj(t)
	fwps := fk["waypoints"].([]any)
	if fk["phase"] != "planning" || fk["visibility"] != "private" || fk["forked_from"] == nil || len(fwps) != 5 {
		t.Fatalf("fork: phase=%v vis=%v forked=%v wps=%d", fk["phase"], fk["visibility"], fk["forked_from"], len(fwps))
	}
	for _, w := range fwps {
		wm := w.(map[string]any)
		if wm["planned"] != true || wm["status"] != "todo" || wm["verdict"] != "" || wm["arrived_at"] != nil {
			t.Fatalf("forked waypoint: %v", wm)
		}
	}
	orig := e.must(200, "GET", fmt.Sprintf("/trips/%d", tripID), "", nil).obj(t)
	if num(orig["fork_count"]) != 1 || num(orig["view_count"]) < 1 || num(orig["planned_count"]) != 3 || num(orig["visited_count"]) != 4 {
		t.Fatalf("original after fork: fork=%v view=%v planned=%v visited=%v", orig["fork_count"], orig["view_count"], orig["planned_count"], orig["visited_count"])
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
	if d := e.must(200, "GET", fmt.Sprintf("/trips/%d", tripID), "", nil).obj(t); num(d["distance_km"]) < 2.3 || d["has_track"] != true {
		t.Fatalf("trip distance should come from track: %v", d["distance_km"])
	}

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
	e.must(200, "PATCH", "/partner", alice, map[string]any{"since": "2023-05-20", "title": "我们的小窝"})
	if p := e.must(200, "GET", "/partner", bob, nil).obj(t); p["since"] != "2023-05-20" || p["title"] != "我们的小窝" {
		t.Fatalf("partner shared settings: %v", p)
	}
	couple := e.must(200, "POST", "/trips", alice, map[string]any{"title": "周末苏州", "phase": "ongoing", "with_partner": true}).obj(t)
	if couple["together"] != true || len(couple["members"].([]any)) != 1 {
		t.Fatalf("together trip: %v", couple)
	}
	e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints", id(couple)), bob, map[string]any{"name": "拙政园", "lng": 120.6270, "lat": 31.3240})
	pf := e.must(200, "GET", "/partner/footprints", bob, nil).obj(t)
	if st := pf["stats"].(map[string]any); num(st["trips"]) != 1 || num(st["cities"]) != 1 {
		t.Fatalf("partner footprints: %v", pf["stats"])
	}
	if pt := items(t, e.must(200, "GET", "/partner/trips", alice, nil)); len(pt) != 1 {
		t.Fatalf("partner trips: %v", pt)
	}
	fp := e.must(200, "GET", "/me/footprints", alice, nil).obj(t)
	provs := fp["provinces"].([]any)
	if len(provs) != 2 || num(fp["stats"].(map[string]any)["provinces"]) != 2 {
		t.Fatalf("footprints provinces: %v", provs)
	}
	ufp := e.must(200, "GET", "/users/alice/footprints", "", nil).obj(t) // only the public trip
	if num(ufp["stats"].(map[string]any)["trips"]) != 1 {
		t.Fatalf("public footprints: %v", ufp["stats"])
	}
	// Members management.
	e.must(409, "POST", fmt.Sprintf("/trips/%d/members", id(couple)), alice, map[string]any{"username": "bob_1"})
	e.register("carol")
	e.must(200, "POST", fmt.Sprintf("/trips/%d/members", id(couple)), alice, map[string]any{"username": "carol"})
	mem := e.must(200, "GET", fmt.Sprintf("/trips/%d/members", id(couple)), bob, nil).arr(t)
	if len(mem) != 3 || mem[0].(map[string]any)["role"] != "owner" || mem[2].(map[string]any)["status"] != "pending" {
		t.Fatalf("members: %v", mem)
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
	e.must(200, "PUT", "/admin/settings", admin, map[string]any{"announcement": "欢迎", "registration_open": false})
	if s := e.must(200, "GET", "/site", "", nil).obj(t); s["announcement"] != "欢迎" || s["registration_open"] != false {
		t.Fatalf("settings: %v", s)
	}
	e.must(403, "POST", "/auth/register", "", map[string]any{"username": "dave", "password": "secret123"})
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
