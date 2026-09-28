package tianditu

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"triphub/internal/geo"
)

type fakeCall struct {
	path string
	post map[string]any
	typ  string
}

func fakeServer(t *testing.T, handle func(w http.ResponseWriter, c fakeCall)) (*httptest.Server, *[]fakeCall) {
	var mu sync.Mutex
	calls := &[]fakeCall{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("tk") != "tk-test" {
			t.Errorf("missing tk: %s", r.URL.RawQuery)
		}
		if ua := r.UserAgent(); !strings.Contains(ua, "Mozilla") {
			t.Errorf("user agent %q", ua)
		}
		var post map[string]any
		if err := json.Unmarshal([]byte(r.URL.Query().Get("postStr")), &post); err != nil {
			t.Errorf("postStr %q: %v", r.URL.Query().Get("postStr"), err)
		}
		c := fakeCall{path: r.URL.Path, post: post, typ: r.URL.Query().Get("type")}
		mu.Lock()
		*calls = append(*calls, c)
		mu.Unlock()
		handle(w, c)
	}))
	t.Cleanup(srv.Close)
	return srv, calls
}

func near(a, b float64) bool { return math.Abs(a-b) < 1e-6 }

func TestSearch(t *testing.T) {
	srv, calls := fakeServer(t, func(w http.ResponseWriter, c fakeCall) {
		if c.path != "/v2/search" || c.typ != "query" {
			http.NotFound(w, nil)
			return
		}
		switch {
		case c.post["queryType"] == float64(12) && c.post["specify"] == "156331000":
			// Documented V2.0 answer: lonlat "lng,lat" in CGCS2000.
			_, _ = w.Write([]byte(`{"resultType":1,"count":"2","keyWord":"那海民宿","pois":[
				{"name":"那海民宿","address":"大陈镇下大陈","lonlat":"121.900001,28.450002","hotPointID":"8F2A","phone":"0576-1234",
				 "poiType":"101","typeName":"旅馆","province":"浙江省","city":"台州市","county":"椒江区","source":"0"},
				{"name":"大陈客运码头","lonlat":"121.91 28.46","hotPointID":"8F2B","poiType":"101","typeName":"客运码头",
				 "province":"浙江省","city":"台州市","county":"椒江区"},
				{"name":"公交站","lonlat":"121.92,28.47","poiType":"102"},
				{"name":"","lonlat":"121.93,28.48"}],
				"status":{"infocode":1000,"cndesc":"服务正常"}}`))
		case c.post["queryType"] == float64(1):
			if c.post["mapBound"] != chinaBound || c.post["level"] == nil {
				t.Errorf("nationwide search: %v", c.post)
			}
			// Many matches: statistics per region instead of places.
			_, _ = w.Write([]byte(`{"resultType":2,"count":40,"statistics":{"count":40,"adminCount":2,
				"priorityCitys":[{"name":"杭州市","count":30,"lonlat":"120.15,30.28","adminCode":156330100}],
				"allAdmins":[{"name":"浙江省","count":40,"adminCode":"156330000"}]},"status":{"infocode":1000,"cndesc":"服务正常"}}`))
		case c.post["queryType"] == float64(12) && c.post["specify"] == "156330100":
			_, _ = w.Write([]byte(`{"resultType":1,"pois":{"name":"楼外楼","lonlat":"120.1437,30.2556","hotPointID":"LWL",
				"typeName":"中餐馆","province":"浙江省","city":"杭州市","county":"西湖区"},"status":{"infocode":"1000"}}`))
		default:
			_, _ = w.Write([]byte(`{"resultType":1,"count":0,"pois":[],"status":{"infocode":1000,"cndesc":"服务正常"}}`))
		}
	})
	c := New("tk-test")
	c.SetBaseURL(srv.URL)
	ctx := context.Background()
	ps, err := c.Search(ctx, "那海民宿", SearchHint{AdminCode: "331000"}, 10)
	if err != nil || len(ps) != 2 {
		t.Fatalf("search: %+v %v", ps, err)
	}
	wantLng, wantLat := geo.WGS84ToGCJ02(121.900001, 28.450002)
	p := ps[0]
	if p.Name != "那海民宿" || p.ID != "8F2A" || p.Category != "hotel" || p.City != "台州市" || p.District != "椒江区" ||
		p.Tel != "0576-1234" || !near(p.Lng, geo.Round(wantLng, 6)) || !near(p.Lat, geo.Round(wantLat, 6)) || p.Lng <= 121.9 {
		t.Fatalf("poi (converted to GCJ-02): %+v", p)
	}
	if ps[1].Name != "大陈客运码头" || ps[1].Category != "transport" || ps[1].Lng <= 121.91 {
		t.Fatalf("space-separated lonlat: %+v", ps[1])
	}
	n := len(*calls)
	if _, err := c.Search(ctx, "那海民宿", SearchHint{AdminCode: "331000"}, 10); err != nil || len(*calls) != n {
		t.Fatalf("search should be cached (%d → %d calls)", n, len(*calls))
	}
	// Nothing in the hinted region: nationwide, then into the region the statistics point to.
	ps, err = c.Search(ctx, "楼外楼", SearchHint{City: "台州市"}, 10)
	if err != nil || len(ps) != 1 || ps[0].Name != "楼外楼" || ps[0].Category != "food" {
		t.Fatalf("statistics follow-up: %+v %v", ps, err)
	}
	var got []string
	for _, call := range (*calls)[n:] {
		got = append(got, fmt.Sprint(call.post["queryType"], "/", call.post["specify"]))
	}
	if strings.Join(got, " ") != "12/台州市 1/<nil> 12/156330100" {
		t.Fatalf("queries: %v", got)
	}
}

func TestRegeo(t *testing.T) {
	var lon, lat float64
	srv, _ := fakeServer(t, func(w http.ResponseWriter, c fakeCall) {
		if c.path != "/geocoder" || c.typ != "geocode" || c.post["ver"] != float64(1) {
			t.Errorf("regeo request: %+v", c)
		}
		lon, lat = c.post["lon"].(float64), c.post["lat"].(float64)
		_, _ = w.Write([]byte(`{"result":{"formatted_address":"浙江省台州市椒江区大陈镇甲午岩","location":{"lon":121.9,"lat":28.45},
			"addressComponent":{"address":"甲午岩景区","city":"台州市","county_code":"156331002","nation":"中国","poi_position":"东北",
			"county":"椒江区","city_code":"156331000","address_position":"东北","poi":"甲午岩","province_code":"156330000",
			"town":"大陈镇","province":"浙江省","road":"环岛公路","road_distance":45,"address_distance":20,"poi_distance":"12"}},
			"msg":"ok","status":"0"}`))
	})
	c := New("tk-test")
	c.SetBaseURL(srv.URL)
	gl, gt := geo.WGS84ToGCJ02(121.9, 28.45)
	r, err := c.Regeo(context.Background(), gl, gt)
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(lon-121.9) > 1e-5 || math.Abs(lat-28.45) > 1e-5 {
		t.Fatalf("the request must be in CGCS2000 / WGS-84: %v,%v", lon, lat)
	}
	if r.Province != "浙江省" || r.City != "台州市" || r.District != "椒江区" || r.Town != "大陈镇" || r.Road != "环岛公路" ||
		r.POI != "甲午岩" || r.POIDistanceM != 12 || r.POIDirection != "东北" || r.Address != "浙江省台州市椒江区大陈镇甲午岩" {
		t.Fatalf("regeo: %+v", r)
	}
	// Municipality without a city; an error status.
	r, err = parseRegeo([]byte(`{"result":{"formatted_address":"北京市东城区","addressComponent":{"province":"北京市","county":"东城区"}},"status":0}`))
	if err != nil || r.City != "北京市" || r.POIDistanceM != -1 {
		t.Fatalf("municipality: %+v %v", r, err)
	}
	if _, err := parseRegeo([]byte(`{"msg":"参数错误","status":"1"}`)); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("error status: %v", err)
	}
}

func TestErrorsAndBreaker(t *testing.T) {
	var mu sync.Mutex
	status, body := http.StatusForbidden, `{"msg":"权限类型错误","resolve":"key权限为浏览器端，请使用浏览器访问","code":"12"}`
	srv, calls := fakeServer(t, func(w http.ResponseWriter, c fakeCall) {
		mu.Lock()
		defer mu.Unlock()
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	})
	c := New("tk-test")
	c.SetBaseURL(srv.URL)
	ctx := context.Background()
	_, err := c.Search(ctx, "x", SearchHint{}, 5)
	if msg := ErrorMessage(err); msg != "天地图 Key 类型不对：请在天地图控制台为本站创建「服务端」类型的 Key" || !errors.Is(err, ErrUnavailable) {
		t.Fatalf("key type: %q %v", msg, err)
	}
	// Paused: no request, the remembered error.
	_, err = c.Regeo(ctx, 120, 30)
	if len(*calls) != 1 || !strings.HasPrefix(ErrorMessage(err), "天地图 Key 类型不对") || !strings.Contains(ErrorMessage(err), "暂停") {
		t.Fatalf("paused: %v (%d calls)", err, len(*calls))
	}
	// Check bypasses the pause, and a success lifts it.
	mu.Lock()
	status, body = http.StatusOK, `{"resultType":1,"pois":[],"status":{"infocode":1000,"cndesc":"服务正常"}}`
	mu.Unlock()
	if err := c.Check(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Search(ctx, "y", SearchHint{}, 5); err != nil {
		t.Fatalf("after check: %v", err)
	}
	for _, tc := range []struct {
		status int
		body   string
		want   string
	}{
		{403, `{"msg":"非法的key","code":301001}`, "天地图 Key 无效，请检查 .env 中的 TIANDITU_KEY"},
		{429, `{"msg":"该tk已限流","code":302010}`, "天地图 Key 已被限流"},
		{200, `{"code":302010,"msg":"该tk已限流"}`, "天地图 Key 已被限流"},
		{200, `{"resultType":1,"status":{"infocode":2001,"cndesc":"参数错误"}}`, "天地图接口返回错误（参数错误）"},
		{502, `bad gateway`, "天地图接口返回 HTTP 502"},
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(tc.status)
			_, _ = w.Write([]byte(tc.body))
		}))
		c := New("tk-test")
		c.SetBaseURL(srv.URL)
		_, err := c.Search(ctx, "x", SearchHint{AdminCode: "110000"}, 5)
		if msg := ErrorMessage(err); !strings.HasPrefix(msg, tc.want) {
			t.Errorf("%d %s: %q, want %q", tc.status, tc.body, msg, tc.want)
		}
		srv.Close()
	}
	// A 401 / 403 / 418 that is not Tianditu's JSON error comes from a proxy,
	// firewall or WAF: never "Key 无效", and no 10-minute key pause.
	for _, tc := range []struct {
		status int
		body   string
		want   string
	}{
		{403, `<html><head><title>403 Forbidden</title></head><body>nginx</body></html>`,
			"天地图拒绝访问（HTTP 403），返回的不是天地图的错误信息：可能被代理、防火墙或网关拦截（HTML 页面「403 Forbidden」）"},
		{403, `Host not in allowlist`, "天地图拒绝访问（HTTP 403），返回的不是天地图的错误信息：可能被代理、防火墙或网关拦截（Host not in allowlist）"},
		{418, `<html><title>CloudWAF</title>waf block</html>`, "天地图拒绝访问（HTTP 418）"},
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(tc.status)
			_, _ = w.Write([]byte(tc.body))
		}))
		c := New("tk-test")
		c.SetBaseURL(srv.URL)
		_, err := c.Search(ctx, "x", SearchHint{AdminCode: "110000"}, 5)
		msg := ErrorMessage(err)
		var e *Error
		if !strings.HasPrefix(msg, tc.want) || strings.Contains(msg, "Key 无效") || !errors.As(err, &e) || !e.Blocked || e.keyError() {
			t.Errorf("%d %s: %q, want %q", tc.status, tc.body, msg, tc.want)
		}
		if d := Details(err); !d.Blocked || d.Layer != "http" || d.Status != tc.status {
			t.Errorf("%d details: %+v", tc.status, d)
		}
		if until := time.Until(time.Unix(0, c.failUntil.Load())); until > 2*time.Minute {
			t.Errorf("%d: paused for %v like a bad key", tc.status, until)
		}
		srv.Close()
	}
	// Unreachable.
	c = New("tk-test")
	c.SetBaseURL("http://127.0.0.1:1")
	_, err = c.Regeo(ctx, 120, 30)
	if ErrorMessage(err) != "服务器无法连接天地图（127.0.0.1:1）：TCP 连接 127.0.0.1:1 失败：连接被拒绝（connection refused）" {
		t.Fatalf("network: %v", err)
	}
	if d := Details(err); d.Layer != "connect" || strings.Contains(d.Detail, "tk-test") || strings.Contains(d.Detail, "postStr") {
		t.Fatalf("network details: %+v", d)
	}
	if _, err := New("").Search(ctx, "x", SearchHint{}, 5); !errors.Is(err, ErrUnavailable) || ErrorMessage(err) != "" {
		t.Fatalf("disabled: %v", err)
	}
}

func TestCategory(t *testing.T) {
	for in, want := range map[string]string{
		"中餐馆": "food", "宾馆饭店": "hotel", "民宿": "hotel", "风景名胜": "scenic", "博物馆": "scenic", "超市": "shopping",
		"火车站": "transport", "电影院": "entertainment", "银行": "other", "": "other",
	} {
		if got := Category(in); got != want {
			t.Errorf("Category(%q) = %s, want %s", in, got, want)
		}
	}
}
