package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"triphub/internal/ai"
	"triphub/internal/amap"
)

// fakeChat answers every chat completion with content and records the
// request bodies.
func fakeChat(t *testing.T, content string) (*httptest.Server, func() []map[string]any) {
	var mu sync.Mutex
	var bodies []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		bodies = append(bodies, body)
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": content}}}})
	}))
	t.Cleanup(srv.Close)
	return srv, func() []map[string]any {
		mu.Lock()
		defer mu.Unlock()
		return append([]map[string]any(nil), bodies...)
	}
}

// taizhouPlan is the model's itinerary for 台州 in two days: names to look
// up, invented coordinates (in 北京, in 杭州, and a plausible guess in 仙居),
// a place in another city of the province, and lodging for both nights (the
// last one is not needed).
const taizhouPlan = `{"title":"台州两日·古城与山水","summary":"临海古城、神仙居","items":[
{"day":1,"kind":"stop","name":"台州府城墙","city":"台州市","district":"临海市","category":"scenic","note":"傍晚登城","lng":116.40,"lat":39.90},
{"day":1,"kind":"stop","name":"紫阳街","city":"台州市","district":"临海市","category":"food","note":"吃麦虾"},
{"day":1,"kind":"lodging","name":"临海古城客栈","city":"台州市","district":"临海市","category":"hotel","note":"住古城里"},
{"day":2,"kind":"stop","name":"神仙居","city":"台州市","district":"仙居县","category":"scenic","note":"坐索道","lng":120.73,"lat":28.85},
{"day":2,"kind":"stop","name":"东海幻境","city":"台州市","category":"scenic","note":"编的","lng":120.15,"lat":30.26},
{"day":2,"kind":"stop","name":"西湖","city":"杭州市","category":"scenic","note":"顺路"},
{"day":2,"kind":"lodging","name":"最后一晚酒店","category":"hotel"}]}`

// fakeTaizhouAmap answers place searches with decoys first (a parking lot,
// a far copy, a farmhouse restaurant for the scenic area), input tips for
// 紫阳街 and the geocoder for 台州市; it records the searches.
func fakeTaizhouAmap(t *testing.T) (*httptest.Server, func() []string) {
	var mu sync.Mutex
	var searches []string
	poi := func(id, name, typ, loc, city, district string) string {
		return `{"id":"` + id + `","name":"` + name + `","type":"` + typ + `","location":"` + loc + `","pname":"浙江省","cityname":"` + city +
			`","adname":"` + district + `","address":"地址"}`
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		mu.Lock()
		searches = append(searches, r.URL.Path+" "+q.Get("keywords")+q.Get("address")+" "+q.Get("city")+" "+q.Get("citylimit"))
		mu.Unlock()
		var pois []string
		switch r.URL.Path {
		case "/v3/geocode/geo":
			_, _ = w.Write([]byte(`{"status":"1","geocodes":[{"formatted_address":"浙江省台州市","province":"浙江省","city":"台州市",
				"district":[],"adcode":"331000","location":"121.420757,28.656386"}]}`))
			return
		case "/v3/assistant/inputtips":
			if q.Get("keywords") == "紫阳街" {
				_, _ = w.Write([]byte(`{"status":"1","tips":[{"id":"B0ZIYANG","name":"紫阳街","district":"浙江省台州市临海市","adcode":"331082",
					"location":"121.1250,28.8580","typecode":"050000"}]}`))
				return
			}
			_, _ = w.Write([]byte(`{"status":"1","tips":[]}`))
			return
		case "/v3/place/text":
			switch q.Get("keywords") {
			case "台州府城墙":
				pois = []string{
					poi("B0PARK", "台州府城墙停车场", "交通设施服务;停车场;停车场", "121.1200,28.8500", "台州市", "临海市"),
					poi("B0WALL", "台州府城墙", "风景名胜;风景名胜;国家级景点", "121.1300,28.8550", "台州市", "临海市"),
				}
			case "临海古城客栈":
				pois = []string{poi("B0INN", "临海古城客栈(紫阳街店)", "住宿服务;宾馆酒店;经济型连锁酒店", "121.1260,28.8570", "台州市", "临海市")}
			case "神仙居":
				pois = []string{poi("B0FARM", "神仙居农家乐", "餐饮服务;中餐厅;农家乐", "120.7400,28.8600", "台州市", "仙居县")}
			case "西湖":
				pois = []string{poi("B0WESTLAKE", "西湖风景名胜区", "风景名胜;风景名胜;国家级景点", "120.1400,30.2400", "杭州市", "西湖区")}
			}
		}
		_, _ = w.Write([]byte(`{"status":"1","count":"` + string(rune('0'+len(pois))) + `","pois":[` + strings.Join(pois, ",") + `]}`))
	}))
	t.Cleanup(srv.Close)
	return srv, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), searches...)
	}
}

// AI plans are grounded on the map inside the destination: the best
// matching result of a city-limited search (not the first), then input
// tips; invented coordinates outside the destination are dropped; lodging
// items stay lodging.
func TestAIPlanGrounding(t *testing.T) {
	e := setup(t)
	aiSrv, _ := fakeChat(t, taizhouPlan)
	e.svc.AI = ai.New(aiSrv.URL, "", "fake", 5*time.Second)
	amapSrv, searches := fakeTaizhouAmap(t)
	am := amap.New("k")
	am.SetBaseURL(amapSrv.URL)
	e.svc.Amap = am
	tok, _, _ := e.register("planner")
	plan := e.must(200, "POST", "/ai/plan", tok, map[string]any{"destination": "台州", "days": 2}).obj(t)
	items := map[string]map[string]any{}
	var order []string
	for _, it := range plan["items"].([]any) {
		m := it.(map[string]any)
		items[m["name"].(string)] = m
		order = append(order, m["name"].(string))
	}
	if len(items) != 6 {
		t.Fatalf("items %v", order)
	}
	check := func(name, kind, amapID string, located bool, lng float64) {
		t.Helper()
		m := items[name]
		if m == nil {
			t.Fatalf("no item %s: %v", name, order)
		}
		gotLng, _ := m["lng"].(float64)
		if m["kind"] != kind || m["amap_id"] != amapID || m["located"] != located || gotLng != lng {
			t.Fatalf("%s: %v", name, m)
		}
	}
	check("台州府城墙", "stop", "B0WALL", true, 121.13)  // not the parking lot, not the model's 北京 coordinates
	check("紫阳街", "stop", "B0ZIYANG", true, 121.125) // from the input tips
	check("临海古城客栈(紫阳街店)", "lodging", "B0INN", true, 121.126)
	check("神仙居", "stop", "", false, 120.73)              // the farmhouse is not it; the guess lies in 台州
	check("东海幻境", "stop", "", false, 0)                  // invented, and the coordinates are in 杭州: dropped
	check("西湖风景名胜区", "stop", "B0WESTLAKE", true, 120.14) // in 杭州, searched there
	if m := items["东海幻境"]; m["lng"] != nil || m["lat"] != nil {
		t.Fatalf("coordinates outside 台州 kept: %v", m)
	}
	if m := items["临海古城客栈(紫阳街店)"]; num(m["day"]) != 1 || m["category"] != "hotel" || m["district"] != "临海市" {
		t.Fatalf("lodging item: %v", m)
	}
	var sawCityLimit, sawHangzhou bool
	for _, s := range searches() {
		if strings.HasPrefix(s, "/v3/place/text 台州府城墙 331000 true") {
			sawCityLimit = true
		}
		if strings.HasPrefix(s, "/v3/place/text 西湖 330100 true") {
			sawHangzhou = true
		}
	}
	if !sawCityLimit || !sawHangzhou {
		t.Fatalf("searches: %v", searches())
	}
	// Saved as planned by a client: the lodging item becomes a lodging waypoint.
	tripID := id(e.must(200, "POST", "/trips", tok, map[string]any{"title": plan["title"], "days": 2}).obj(t))
	var batch []any
	for _, name := range order {
		m := items[name]
		if m["lng"] == nil {
			continue
		}
		batch = append(batch, map[string]any{"name": m["name"], "kind": m["kind"], "day": m["day"], "lng": m["lng"], "lat": m["lat"],
			"category": m["category"], "amap_id": m["amap_id"]})
	}
	saved := e.must(200, "POST", "/trips/"+itoa(tripID)+"/waypoints/batch", tok, map[string]any{"items": batch}).arr(t)
	lodging := 0
	for _, w := range saved {
		if w.(map[string]any)["kind"] == "lodging" {
			lodging++
		}
	}
	if lodging != 1 {
		t.Fatalf("saved: %v", saved)
	}
}

func itoa(v int64) string { b, _ := json.Marshal(v); return string(b) }

func TestAIPreferences(t *testing.T) {
	e := setup(t)
	srv, bodies := fakeChat(t, `{"suggestions":["节奏轻松，每天不超过 4 个景点","想吃地道的台州海鲜。","节奏轻松，每天不超过 4 个景点","  ",
		"喜欢拍照","不想太累"],"text":"不想太累，节奏轻松，每天不超过 4 个景点，想吃地道的台州海鲜。"}`)
	e.svc.AI = ai.New(srv.URL, "", "fake", 5*time.Second)
	tok, _, _ := e.register("planner")
	body := map[string]any{"destination": "台州", "days": 2, "start_date": "2026-10-01", "together": true, "draft": "不想太累"}
	e.must(401, "POST", "/ai/preferences", "", body)
	e.must(400, "POST", "/ai/preferences", tok, map[string]any{"destination": " "})
	e.must(400, "POST", "/ai/preferences", tok, map[string]any{"destination": "台州", "days": 30})
	res := e.must(200, "POST", "/ai/preferences", tok, body).obj(t)
	sug := res["suggestions"].([]any)
	if len(sug) != 3 || sug[0] != "节奏轻松，每天不超过 4 个景点" || sug[1] != "想吃地道的台州海鲜" || sug[2] != "喜欢拍照" ||
		!strings.HasPrefix(res["text"].(string), "不想太累") {
		t.Fatalf("preferences: %v", res)
	}
	req := bodies()[0]
	prompt := req["messages"].([]any)[1].(map[string]any)["content"].(string)
	if req["max_tokens"] != float64(600) || req["stream"] != false || !strings.Contains(prompt, "台州") ||
		!strings.Contains(prompt, "情侣") || !strings.Contains(prompt, "秋季") || !strings.Contains(prompt, "不想太累") {
		t.Fatalf("request: %v", req)
	}
	e.svc.AI = ai.New("", "", "", 0)
	e.must(400, "POST", "/ai/preferences", tok, body)
}
