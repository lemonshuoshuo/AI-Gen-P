package handler

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"triphub/internal/ai"
	"triphub/internal/amap"
	"triphub/internal/tianditu"
)

// pickRegeo is a /v3/geocode/regeo answer (extensions=all) for a click in
// 甲午岩景区 on 大陈岛, 台州.
const pickRegeo = `{"status":"1","info":"OK","infocode":"10000","regeocode":{
	"formatted_address":"浙江省台州市椒江区大陈镇甲午岩景区",
	"addressComponent":{"province":"浙江省","city":"台州市","district":"椒江区","township":"大陈镇","adcode":"331002",
		"neighborhood":{"name":[],"type":[]},"building":{"name":[],"type":[]},
		"streetNumber":{"street":"环岛公路","number":"8号","location":"121.9,28.45","direction":"东","distance":"40"},"businessAreas":[[]]},
	"roads":[{"id":"1","name":"环岛公路","distance":"30","direction":"东","location":"121.9,28.45"}],"roadinters":[],
	"pois":[
		{"id":"B0POIPARK1","name":"甲午岩停车场","type":"交通设施服务;停车场;停车场","tel":[],"distance":"80","location":"121.9008,28.4506","address":[]},
		{"id":"B0POIVIEW1","name":"观海亭","type":"风景名胜;风景名胜相关;旅游景点","tel":[],"distance":"25","location":"121.9002,28.4501","address":"甲午岩景区内"},
		{"id":"B0POIDUP01","name":"甲午岩景区","type":"风景名胜;风景名胜;国家级景点","tel":[],"distance":"60","location":"121.9004,28.4503","address":[]},
		{"id":"B0POIFAR01","name":"远处的店","type":"餐饮服务;中餐厅","tel":[],"distance":"350","location":"121.903,28.452","address":[]}],
	"aois":[
		{"id":"B0AOIISL01","name":"大陈岛","adcode":"331002","location":"121.89,28.44","area":"12000000","distance":"0","type":"110000"},
		{"id":"B0AOIROCK1","name":"甲午岩景区","adcode":"331002","location":"121.9001,28.4502","area":"250000","distance":"0","type":"110202"},
		{"id":"B0AOIPORT1","name":"大陈渔港","adcode":"331002","location":"121.95,28.46","area":"50000","distance":"120","type":"150000"}]}}`

func fakePickAmap(t *testing.T, failing *atomic.Bool) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if failing != nil && failing.Load() {
			_, _ = w.Write([]byte(`{"status":"0","info":"USERKEY_PLAT_NOMATCH","infocode":"10009"}`))
			return
		}
		switch r.URL.Path {
		case "/v3/geocode/regeo":
			if r.URL.Query().Get("extensions") != "all" {
				t.Errorf("regeo without extensions=all: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(pickRegeo))
		case "/v3/assistant/inputtips":
			_, _ = w.Write([]byte(`{"status":"1","count":"1","infocode":"10000","tips":[{"id":"B0TIPNAHAI","name":"那海民宿",
				"district":"浙江省台州市椒江区","adcode":"331002","location":"121.910000,28.460000","address":"下大陈","typecode":"100200"}]}`))
		default:
			_, _ = w.Write([]byte(`{"status":"1","count":"0","infocode":"10000","pois":[]}`))
		}
	}))
}

func TestGeoPick(t *testing.T) {
	e := setup(t)
	alice, _, _ := e.register("alice")
	mallory, _, _ := e.register("mallory")
	// Community places near the click: a public one, and one only in mallory's private trip.
	pub := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "大陈岛", "visibility": "public", "phase": "finished"}).obj(t))
	e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints", pub), alice, map[string]any{
		"name": "岛上咖啡", "lng": 121.9005, "lat": 28.4500, "planned": false, "status": "visited", "verdict": "recommend", "category": "food"})
	e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints", pub), alice, map[string]any{
		"name": "观海亭", "lng": 121.9002, "lat": 28.4501, "planned": false, "status": "visited", "verdict": "avoid"})
	priv := id(e.must(200, "POST", "/trips", mallory, map[string]any{"title": "秘密"}).obj(t))
	e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints", priv), mallory, map[string]any{"name": "我家", "lng": 121.9001, "lat": 28.4500})

	path := "/geo/pick?lng=121.9&lat=28.45"
	e.must(401, "GET", path, "", nil)
	e.must(400, "GET", "/geo/pick", alice, nil)

	// Without any map service: community places and the offline city.
	r := e.must(200, "GET", path, alice, nil).obj(t)
	cands := r["candidates"].([]any)
	if r["source"] != "local" || r["amap_error"] != nil || r["address"].(map[string]any)["city"] != "台州市" {
		t.Fatalf("local pick: %v", r)
	}
	var kinds []string
	for _, c := range cands {
		m := c.(map[string]any)
		kinds = append(kinds, m["kind"].(string)+":"+m["name"].(string))
	}
	if strings.Join(kinds, ",") != "place:观海亭,place:岛上咖啡,address:椒江区" && strings.Join(kinds, ",") != "place:观海亭,place:岛上咖啡,address:台州市" {
		t.Fatalf("local candidates (no private place): %v", kinds)
	}

	srv := fakePickAmap(t, nil)
	t.Cleanup(srv.Close)
	am := amap.New("test-key")
	am.SetBaseURL(srv.URL)
	e.svc.Amap = am
	r = e.must(200, "GET", path, mallory, nil).obj(t)
	if r["source"] != "amap" || r["amap_error"] != nil {
		t.Fatalf("amap pick: %v", r)
	}
	addr := r["address"].(map[string]any)
	if addr["province"] != "浙江省" || addr["city"] != "台州市" || addr["district"] != "椒江区" || addr["street"] != "大陈镇" ||
		addr["address"] != "浙江省台州市椒江区大陈镇甲午岩景区" {
		t.Fatalf("address: %v", addr)
	}
	kinds = nil
	for _, c := range r["candidates"].([]any) {
		m := c.(map[string]any)
		kinds = append(kinds, fmt.Sprintf("%s:%s:%v", m["kind"], m["name"], m["distance_m"]))
	}
	want := []string{
		"aoi:甲午岩景区:0",  // inside, the smallest area first
		"aoi:大陈岛:0",    // inside
		"aoi:大陈渔港:120", // near
		"poi:观海亭:25",   // POIs and community places by distance (the POI 甲午岩景区 is a duplicate name)
		"place:我家:10",  // mallory's own private place is visible to her...
		"place:岛上咖啡:49",
		"poi:甲午岩停车场:80",
		"address:大陈镇 · 环岛公路:0", // the point itself, last
	}
	// ...sorted by distance among POIs / places.
	want = []string{want[0], want[1], want[2], want[4], want[3], want[5], want[6], want[7]}
	if strings.Join(kinds, ",") != strings.Join(want, ",") {
		t.Fatalf("candidates:\n got %v\nwant %v", kinds, want)
	}
	cs := r["candidates"].([]any)
	rock := cs[0].(map[string]any)
	if rock["amap_id"] != "B0AOIROCK1" || rock["category"] != "scenic" || num(rock["lng"]) != 121.9001 || rock["place"] != nil {
		t.Fatalf("aoi candidate: %v", rock)
	}
	view := cs[4].(map[string]any)
	if view["amap_id"] != "B0POIVIEW1" || view["place_id"] == nil || view["place"] == nil ||
		num(view["place"].(map[string]any)["avoid_count"]) != 1 {
		t.Fatalf("a POI with a community place carries its stats: %v", view)
	}
	last := cs[len(cs)-1].(map[string]any)
	if last["kind"] != "address" || num(last["lng"]) != 121.9 || num(last["lat"]) != 28.45 || last["amap_id"] != "" {
		t.Fatalf("address candidate: %v", last)
	}
	// Alice does not see mallory's private place.
	for _, c := range e.must(200, "GET", path, alice, nil).obj(t)["candidates"].([]any) {
		if c.(map[string]any)["name"] == "我家" {
			t.Fatal("a private place leaked into another user's pick")
		}
	}

	// A key for the wrong platform: the local answer, and why.
	var failing atomic.Bool
	failing.Store(true)
	bad := fakePickAmap(t, &failing)
	t.Cleanup(bad.Close)
	badAm := amap.New("test-key")
	badAm.SetBaseURL(bad.URL)
	e.svc.Amap = badAm
	r = e.must(200, "GET", "/geo/pick?lng=121.91&lat=28.45", alice, nil).obj(t)
	if r["source"] != "local" || r["amap_error"] != "高德 Key 的服务平台不是「Web服务」：请在高德控制台为本站创建服务平台为「Web服务」的 Key" {
		t.Fatalf("amap_error: %v", r)
	}
	// Paused after the key error: still explained.
	r = e.must(200, "GET", "/geo/search?keyword="+url.QueryEscape("那海民宿"), alice, nil).obj(t)
	if r["source"] != "local" || !strings.HasPrefix(fmt.Sprint(r["amap_error"]), "高德 Key 的服务平台不是「Web服务」") {
		t.Fatalf("search while paused: %v", r)
	}
	r = e.must(200, "GET", "/geo/around?lng=121.9&lat=28.45", alice, nil).obj(t)
	if r["source"] != "none" || len(r["items"].([]any)) != 0 || !strings.HasPrefix(fmt.Sprint(r["amap_error"]), "高德 Key 的服务平台不是") {
		t.Fatalf("around while paused: %v", r)
	}

	// Tianditu as the fallback.
	tdt := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/geocoder":
			_, _ = w.Write([]byte(`{"result":{"formatted_address":"浙江省台州市椒江区大陈镇甲午岩","addressComponent":{"address":"甲午岩",
				"city":"台州市","county":"椒江区","poi":"甲午岩","poi_distance":35,"poi_position":"东","town":"大陈镇","province":"浙江省",
				"road":"环岛公路"}},"msg":"ok","status":"0"}`))
		case "/v2/search":
			_, _ = w.Write([]byte(`{"resultType":1,"pois":[{"name":"那海民宿","address":"下大陈","lonlat":"121.905,28.455","hotPointID":"X1",
				"typeName":"旅馆","province":"浙江省","city":"台州市","county":"椒江区"}],"status":{"infocode":1000,"cndesc":"服务正常"}}`))
		}
	}))
	t.Cleanup(tdt.Close)
	td := tianditu.New("tk")
	td.SetBaseURL(tdt.URL)
	e.svc.Tianditu = td
	r = e.must(200, "GET", "/geo/pick?lng=121.92&lat=28.45", alice, nil).obj(t)
	cs = r["candidates"].([]any)
	if r["source"] != "tianditu" || r["amap_error"] == nil || cs[0].(map[string]any)["name"] != "甲午岩" ||
		cs[0].(map[string]any)["kind"] != "poi" || num(cs[0].(map[string]any)["distance_m"]) != 35 ||
		cs[len(cs)-1].(map[string]any)["name"] != "大陈镇 · 环岛公路" {
		t.Fatalf("tianditu pick: %v", r)
	}
	r = e.must(200, "GET", "/geo/search?keyword="+url.QueryEscape("那海民宿")+"&lng=121.9&lat=28.45", alice, nil).obj(t)
	it := r["items"].([]any)
	if r["source"] != "tianditu" || r["amap_error"] == nil || len(it) != 1 {
		t.Fatalf("tianditu search: %v", r)
	}
	if m := it[0].(map[string]any); m["name"] != "那海民宿" || m["category"] != "hotel" || m["amap_id"] != "" || num(m["lng"]) <= 121.905 {
		t.Fatalf("tianditu item (GCJ-02): %v", m)
	}
	if s := e.must(200, "GET", "/site", "", nil).obj(t); s["place_search"] != true || s["amap_search"] != true {
		t.Fatalf("site: %v", s)
	}

	// A working key: the search box finds the 民宿 through the input tips.
	e.svc.Amap = am
	r = e.must(200, "GET", "/geo/search?keyword="+url.QueryEscape("台州那海民宿"), alice, nil).obj(t)
	it = r["items"].([]any)
	if r["source"] != "amap" || r["amap_error"] != nil || len(it) != 1 {
		t.Fatalf("amap search with tips: %v", r)
	}
	if m := it[0].(map[string]any); m["amap_id"] != "B0TIPNAHAI" || m["city"] != "台州市" || m["province"] != "浙江省" || m["district"] != "椒江区" {
		t.Fatalf("tip item: %v", m)
	}
}

// Auto-named waypoints take the name of the AOI they are in.
func TestAutoNameFromAOI(t *testing.T) {
	e := setup(t)
	srv := fakePickAmap(t, nil)
	t.Cleanup(srv.Close)
	am := amap.New("test-key")
	am.SetBaseURL(srv.URL)
	e.svc.Amap = am
	tok, _, _ := e.register("walker")
	trip := id(e.must(200, "POST", "/trips", tok, map[string]any{"title": "大陈岛", "phase": "ongoing"}).obj(t))
	c := e.must(200, "POST", fmt.Sprintf("/trips/%d/checkin", trip), tok, map[string]any{"lng": 121.9, "lat": 28.45}).obj(t)
	if w := c["waypoint"].(map[string]any); w["name"] != "甲午岩景区" || w["district"] != "椒江区" {
		t.Fatalf("unnamed check-in: %v", w)
	}
	up := e.upload(fmt.Sprintf("/trips/%d/photos", trip), tok, testJPEG(t, 64, 48), map[string]string{
		"lng": "121.95", "lat": "28.40", "coord_type": "gcj02", "auto_waypoint": "true", "taken_at": "2026-05-01T10:00:00+08:00"})
	if up.status != 200 {
		t.Fatalf("upload: %d %s", up.status, up.body)
	}
	if w, _ := up.obj(t)["waypoint"].(map[string]any); w == nil || w["name"] != "甲午岩景区" {
		t.Fatalf("photo auto-waypoint: %s", up.body)
	}
	if r := e.must(200, "GET", "/geo/regeo?lng=121.9&lat=28.45", tok, nil).obj(t); r["spot"] != "甲午岩景区" || r["street"] != "大陈镇" {
		t.Fatalf("regeo spot: %v", r)
	}
}

func TestFootprintPhotoThumbs(t *testing.T) {
	e := setup(t)
	alice, _, _ := e.register("alice")
	bob, _, _ := e.register("bob")
	trip := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "西湖", "visibility": "public", "phase": "finished"}).obj(t))
	w1 := id(e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints", trip), alice, map[string]any{
		"name": "断桥", "lng": 120.1513, "lat": 30.2610, "planned": false, "status": "visited", "arrived_at": "2026-05-01T09:00:00+08:00"}).obj(t))
	w2 := id(e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints", trip), alice, map[string]any{
		"name": "楼外楼", "lng": 120.1437, "lat": 30.2556, "planned": false, "status": "visited", "arrived_at": "2026-05-01T12:00:00+08:00"}).obj(t))
	upload := func(wp int64, taken string) string {
		t.Helper()
		r := e.upload(fmt.Sprintf("/trips/%d/photos", trip), alice, testJPEG(t, 64, 48), map[string]string{
			"waypoint_id": fmt.Sprint(wp), "taken_at": taken})
		if r.status != 200 {
			t.Fatalf("upload: %d %s", r.status, r.body)
		}
		return r.obj(t)["photo"].(map[string]any)["thumb_url"].(string)
	}
	upload(w1, "2026-05-01T09:30:00+08:00")
	first := upload(w1, "2026-05-01T09:10:00+08:00") // taken earlier: first on the trip page
	thumbs := func(path, tok string) map[int64]string {
		t.Helper()
		out := map[int64]string{}
		for _, p := range e.must(200, "GET", path, tok, nil).obj(t)["points"].([]any) {
			m := p.(map[string]any)
			th, ok := m["photo_thumb_url"].(string)
			if !ok {
				t.Fatalf("point without photo_thumb_url: %v", m)
			}
			out[int64(num(m["waypoint_id"]))] = th
		}
		return out
	}
	want := map[int64]string{w1: first, w2: ""}
	for _, v := range []struct{ path, tok string }{{"/me/footprints", alice}, {"/users/alice/footprints", bob}, {"/users/alice/footprints", ""}} {
		if got := thumbs(v.path, v.tok); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: %v, want %v", v.path, got, want)
		}
	}
	// Travelling without live sharing: the trip (and its photos) leave the public footprints.
	e.must(200, "PATCH", fmt.Sprintf("/trips/%d", trip), alice, map[string]any{"phase": "ongoing", "live_share": false})
	if got := thumbs("/users/alice/footprints", bob); len(got) != 0 {
		t.Fatalf("hidden live trip: %v", got)
	}
	if got := thumbs("/me/footprints", alice); got[w1] != first {
		t.Fatalf("own footprints: %v", got)
	}
}

// fakeStreamingAI streams its itinerary as server-sent events (with DeepSeek
// style reasoning first), or fails as told by the model name.
func fakeStreamingAI(t *testing.T, requests *atomic.Int32) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		content := `{"title":"杭州两日·湖光山色","summary":"轻松游西湖","items":[` +
			`{"day":1,"name":"断桥残雪","address":"北山街","category":"scenic","note":"清晨人少","lng":120.1520,"lat":30.2615},` +
			`{"day":2,"name":"西溪湿地","category":"scenic","note":"坐摇橹船","lng":120.0700,"lat":30.2700}]}`
		switch {
		case req["model"] == "bad-key":
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"message":"Authentication Fails"}}`))
			return
		case req["stream"] != true:
			_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": content}}}})
			return
		case req["model"] == "no-stream":
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"message":"stream is not supported"}}`))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		send := func(field, text string) {
			b, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{field: text}}}})
			_, _ = fmt.Fprintf(w, "data: %s\n\n", b)
			w.(http.Flusher).Flush()
		}
		send("reasoning_content", "用户想去杭州两天，")
		time.Sleep(150 * time.Millisecond) // long enough for a ping in the test
		send("reasoning_content", "安排西湖和西溪。")
		runes := []rune(content)
		for i := 0; i < len(runes); i += 40 {
			send("content", string(runes[i:min(i+40, len(runes))]))
		}
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
}

type sseEvent struct {
	name string
	data string
}

func readSSE(t *testing.T, body io.Reader) (events []sseEvent, comments []string) {
	t.Helper()
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	var cur sseEvent
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
			if cur.name != "" || cur.data != "" {
				events = append(events, cur)
			}
			cur = sseEvent{}
		case strings.HasPrefix(line, ":"):
			comments = append(comments, strings.TrimSpace(line[1:]))
		case strings.HasPrefix(line, "event: "):
			cur.name = line[len("event: "):]
		case strings.HasPrefix(line, "data: "):
			cur.data += line[len("data: "):]
		}
	}
	return events, comments
}

func (e *env) stream(path, token string, body any) (*http.Response, []sseEvent, []string) {
	e.t.Helper()
	b, _ := json.Marshal(body)
	r, _ := http.NewRequest(http.MethodPost, e.base+path, bytes.NewReader(b))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Accept-Encoding", "gzip")
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultTransport.RoundTrip(r) // no transparent gunzip: the stream must not be compressed
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(res.Body)
		e.t.Fatalf("stream %s: %d %s", path, res.StatusCode, data)
	}
	events, comments := readSSE(e.t, res.Body)
	return res, events, comments
}

func TestAIPlanStream(t *testing.T) {
	e := setup(t)
	var requests atomic.Int32
	srv := fakeStreamingAI(t, &requests)
	t.Cleanup(srv.Close)
	useModel := func(model string) {
		e.svc.AI = ai.NewClient(ai.Config{BaseURL: srv.URL + "/v1", Model: model, Timeout: 5 * time.Second})
	}
	useModel("fake")
	oldPing, oldGap := ssePing, sseProgressGap
	ssePing, sseProgressGap = 100*time.Millisecond, 20*time.Millisecond
	t.Cleanup(func() { ssePing, sseProgressGap = oldPing, oldGap })

	tok, _, _ := e.register("planner")
	body := map[string]any{"destination": "杭州", "days": 2, "preferences": "美食"}
	e.must(401, "POST", "/ai/plan/stream", "", body)
	e.must(400, "POST", "/ai/plan/stream", tok, map[string]any{"destination": "杭州", "days": 99}) // plain JSON errors before the stream

	res, events, comments := e.stream("/ai/plan/stream", tok, body)
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") ||
		res.Header.Get("Cache-Control") != "no-cache" || res.Header.Get("X-Accel-Buffering") != "no" || res.Header.Get("Content-Encoding") != "" {
		t.Fatalf("headers: %v", res.Header)
	}
	if len(events) < 3 {
		t.Fatalf("events: %v", events)
	}
	stages := []string{}
	for _, ev := range events[:len(events)-1] {
		if ev.name != "progress" {
			t.Fatalf("unexpected event %v", ev)
		}
		var p struct {
			Stage   string `json:"stage"`
			Chars   int    `json:"chars"`
			Message string `json:"message"`
		}
		if err := json.Unmarshal([]byte(ev.data), &p); err != nil || p.Message == "" {
			t.Fatalf("progress %q: %v", ev.data, err)
		}
		if len(stages) == 0 || stages[len(stages)-1] != p.Stage {
			stages = append(stages, p.Stage)
		}
	}
	if strings.Join(stages, ",") != "thinking,writing,locating" {
		t.Fatalf("stages: %v", stages)
	}
	if len(comments) == 0 || comments[0] != "ping" {
		t.Fatalf("no heartbeat: %v", comments)
	}
	last := events[len(events)-1]
	if last.name != "result" {
		t.Fatalf("last event: %v", last)
	}
	var streamed, plain map[string]any
	if err := json.Unmarshal([]byte(last.data), &streamed); err != nil {
		t.Fatal(err)
	}
	plain = e.must(200, "POST", "/ai/plan", tok, body).obj(t)
	if !reflect.DeepEqual(streamed, plain) || streamed["title"] != "杭州两日·湖光山色" || len(streamed["items"].([]any)) != 2 {
		t.Fatalf("stream result differs from POST /ai/plan:\n%v\n%v", streamed, plain)
	}

	// A provider without streaming: the same stream, answered by a normal request.
	useModel("no-stream")
	n := requests.Load()
	_, events, _ = e.stream("/ai/plan/stream", tok, body)
	if last := events[len(events)-1]; last.name != "result" || requests.Load() != n+2 {
		t.Fatalf("fallback: %v (%d requests)", events, requests.Load()-n)
	}
	// A bad key: an error event with the reason.
	useModel("bad-key")
	_, events, _ = e.stream("/ai/plan/stream", tok, body)
	if last := events[len(events)-1]; last.name != "error" || !strings.Contains(last.data, "AI Key 无效或没有权限") {
		t.Fatalf("error event: %v", events)
	}
	r := e.must(500, "POST", "/ai/plan", tok, body).obj(t)
	if r["error"].(map[string]any)["message"] != "AI Key 无效或没有权限（HTTP 401：Authentication Fails）：请检查 .env 中的 AI_API_KEY 是否完整、没有多余的引号或空格" {
		t.Fatalf("plain error: %v", r)
	}
}

func TestAdminDiagnostics(t *testing.T) {
	e := setup(t)
	admin := e.adminToken()
	user, _, _ := e.register("someone")
	e.must(403, "GET", "/admin/diagnostics", user, nil)
	d := e.must(200, "GET", "/admin/diagnostics", admin, nil).obj(t)
	am, aiD, td := d["amap"].(map[string]any), d["ai"].(map[string]any), d["tianditu"].(map[string]any)
	if am["configured"] != false || am["ok"] != false || td["configured"] != false || aiD["configured"] != true || aiD["ok"] != true ||
		aiD["model"] != "fake" || aiD["thinking"] != "off" || !strings.HasPrefix(aiD["message"].(string), "正常") {
		t.Fatalf("diagnostics: %v", d)
	}

	var mu sync.Mutex
	var amapQueries []string
	amapSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		amapQueries = append(amapQueries, r.URL.Path+"?"+r.URL.Query().Get("keywords"))
		mu.Unlock()
		_, _ = w.Write([]byte(`{"status":"0","info":"USERKEY_PLAT_NOMATCH","infocode":"10009"}`))
	}))
	t.Cleanup(amapSrv.Close)
	am2 := amap.New("secret-amap-key")
	am2.SetBaseURL(amapSrv.URL)
	e.svc.Amap = am2
	aiSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusPaymentRequired)
		_, _ = w.Write([]byte(`{"error":{"message":"Insufficient Balance"}}`))
	}))
	t.Cleanup(aiSrv.Close)
	e.svc.AI = ai.NewClient(ai.Config{BaseURL: aiSrv.URL + "/chat/completions", APIKey: "sk-secret", Model: "deepseek-flash"})
	tdtSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"msg":"权限类型错误","resolve":"key权限为浏览器端，请使用浏览器访问","code":"12"}`))
	}))
	t.Cleanup(tdtSrv.Close)
	td2 := tianditu.New("secret-tdt-key")
	td2.SetBaseURL(tdtSrv.URL)
	e.svc.Tianditu = td2

	raw := e.must(200, "GET", "/admin/diagnostics", admin, nil)
	for _, secret := range []string{"secret-amap-key", "sk-secret", "secret-tdt-key"} {
		if bytes.Contains(raw.body, []byte(secret)) {
			t.Fatalf("a key leaked: %s", raw.body)
		}
	}
	d = raw.obj(t)
	am, aiD, td = d["amap"].(map[string]any), d["ai"].(map[string]any), d["tianditu"].(map[string]any)
	if am["configured"] != true || am["ok"] != false || am["infocode"] != "10009" || !strings.Contains(am["message"].(string), "Web服务") ||
		am["layer"] != "api" || am["detail"] != "infocode 10009: USERKEY_PLAT_NOMATCH" ||
		am["key_hint"].(map[string]any)["text"] != "长度 15 · se…ey（含非十六进制字符）" || am["key_hint"].(map[string]any)["warning"] == nil ||
		am["host"] == nil {
		t.Fatalf("amap diagnostics: %v", am)
	}
	if aiD["ok"] != false || aiD["message"] != "AI 账户余额或额度不足（HTTP 402），请到模型服务商的控制台充值" || aiD["base_url"] != aiSrv.URL ||
		aiD["model"] != "deepseek-flash" || aiD["kind"] != "balance" || aiD["layer"] != "http" || num(aiD["status"]) != 402 ||
		!strings.HasPrefix(aiD["detail"].(string), "Insufficient Balance") || aiD["key_hint"].(map[string]any)["text"] != "长度 9 · sk…et" {
		t.Fatalf("ai diagnostics: %v", aiD)
	}
	if td["configured"] != true || td["ok"] != false || !strings.Contains(td["message"].(string), "服务端") ||
		td["layer"] != "http" || num(td["status"]) != 403 {
		t.Fatalf("tianditu diagnostics: %v", td)
	}

	// Unreachable services: the layer that failed and the Go error, never
	// "Key 无效" or "换用更快的模型".
	closed := httptest.NewServer(http.NotFoundHandler())
	closedURL := closed.URL
	closed.Close()
	am3 := amap.New("0123456789abcdef0123456789abcdef")
	am3.SetBaseURL(closedURL)
	e.svc.Amap = am3
	e.svc.AI = ai.NewClient(ai.Config{BaseURL: closedURL, APIKey: "sk-0123456789abcdef0123456789abcdef", Model: "deepseek-flash"})
	e.svc.Tianditu = tianditu.New("")
	raw = e.must(200, "GET", "/admin/diagnostics", admin, nil)
	for _, secret := range []string{"0123456789abcdef0123456789abcdef", "sk-0123456789abcdef0123456789abcdef"} {
		if bytes.Contains(raw.body, []byte(secret)) {
			t.Fatalf("a key leaked: %s", raw.body)
		}
	}
	d = raw.obj(t)
	am, aiD = d["amap"].(map[string]any), d["ai"].(map[string]any)
	host := strings.TrimPrefix(closedURL, "http://")
	if am["ok"] != false || am["layer"] != "connect" || !strings.Contains(am["detail"].(string), "connection refused") ||
		am["message"] != "服务器无法连接高德（"+host+"）：TCP 连接 "+host+" 失败：连接被拒绝（connection refused）" ||
		am["key_hint"].(map[string]any)["text"] != "长度 32 · 0123…cdef" || am["key_hint"].(map[string]any)["warning"] != nil {
		t.Fatalf("unreachable amap: %v", am)
	}
	if aiD["ok"] != false || aiD["layer"] != "connect" || aiD["kind"] != "network" || !strings.Contains(aiD["detail"].(string), "connection refused") ||
		strings.Contains(aiD["message"].(string), "Key 无效") || strings.Contains(aiD["message"].(string), "换用更快的模型") {
		t.Fatalf("unreachable ai: %v", aiD)
	}
	if strings.Contains(fmt.Sprint(d["tianditu"]), "layer") {
		t.Fatalf("an unconfigured service has no details: %v", d["tianditu"])
	}

	// A firewall / WAF page instead of the provider's answer: blocked, never
	// "Key 无效".
	wafSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`<html><head><title>Access Denied</title></head><body>blocked</body></html>`))
	}))
	t.Cleanup(wafSrv.Close)
	td3 := tianditu.New("0123456789abcdef0123456789abcdef")
	td3.SetBaseURL(wafSrv.URL)
	e.svc.Tianditu = td3
	e.svc.AI = ai.NewClient(ai.Config{BaseURL: wafSrv.URL, APIKey: "sk-0123456789abcdef0123456789abcdef", Model: "deepseek-flash"})
	d = e.must(200, "GET", "/admin/diagnostics", admin, nil).obj(t)
	aiD, td = d["ai"].(map[string]any), d["tianditu"].(map[string]any)
	if td["ok"] != false || td["blocked"] != true || td["layer"] != "http" || num(td["status"]) != 403 ||
		strings.Contains(td["message"].(string), "Key 无效") {
		t.Fatalf("blocked tianditu: %v", td)
	}
	if aiD["ok"] != false || aiD["blocked"] != true || strings.Contains(aiD["message"].(string), "Key 无效") {
		t.Fatalf("blocked ai: %v", aiD)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(amapQueries) != 1 || amapQueries[0] != "/v3/place/text?天安门" {
		t.Fatalf("amap check: %v", amapQueries)
	}
}

// seaRegeo is AMap's answer for a point in the sea off 台州: the country as
// province and address, and a POI nearby.
const seaRegeo = `{"status":"1","info":"OK","infocode":"10000","regeocode":{"formatted_address":"中华人民共和国",
	"addressComponent":{"country":"中国","province":"中华人民共和国","city":[],"citycode":[],"district":[],"adcode":"100000",
		"township":[],"towncode":[],"neighborhood":{"name":[],"type":[]},"building":{"name":[],"type":[]},
		"streetNumber":{"street":[],"number":[],"direction":[],"distance":[]},"businessAreas":[]},
	"pois":[{"id":"B0SEAWIND1","name":"海上观景平台","type":"风景名胜;风景名胜相关;旅游景点","distance":"150","location":"121.9075,28.4560","address":[]}],
	"roads":[],"roadinters":[],"aois":[]}}`

// A click in the sea: AMap knows no province; the offline atlas names the
// province and city, nearby POIs are still offered, and "中华人民共和国" is
// never shown as a place.
func TestGeoPickSea(t *testing.T) {
	e := setup(t)
	tok, _, _ := e.register("sailor")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(seaRegeo))
	}))
	t.Cleanup(srv.Close)
	am := amap.New("test-key")
	am.SetBaseURL(srv.URL)
	e.svc.Amap = am
	raw := e.must(200, "GET", "/geo/pick?lng=121.9063&lat=28.4556", tok, nil)
	if bytes.Contains(raw.body, []byte("中华人民共和国")) {
		t.Fatalf("the country is shown as a place: %s", raw.body)
	}
	r := raw.obj(t)
	addr := r["address"].(map[string]any)
	if r["source"] != "amap" || addr["province"] != "浙江省" || addr["city"] != "台州市" || addr["address"] != "浙江省台州市" {
		t.Fatalf("sea pick address: %v", r)
	}
	cs := r["candidates"].([]any)
	if len(cs) != 2 || cs[0].(map[string]any)["name"] != "海上观景平台" || cs[0].(map[string]any)["kind"] != "poi" ||
		cs[1].(map[string]any)["kind"] != "address" || cs[1].(map[string]any)["name"] != "台州市" {
		t.Fatalf("sea pick candidates: %v", cs)
	}
	raw = e.must(200, "GET", "/geo/regeo?lng=121.9063&lat=28.4556", tok, nil)
	if bytes.Contains(raw.body, []byte("中华人民共和国")) {
		t.Fatalf("the country is shown as a place: %s", raw.body)
	}
	if r := raw.obj(t); r["province"] != "浙江省" || r["city"] != "台州市" || r["address"] != "浙江省台州市" {
		t.Fatalf("sea regeo: %v", r)
	}
}
