package amap

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCategory(t *testing.T) {
	cases := map[string]string{
		"餐饮服务;中餐厅;浙江菜":     "food",
		"风景名胜;风景名胜;国家级景点":  "scenic",
		"住宿服务;宾馆酒店;五星级宾馆":  "hotel",
		"购物服务;商场;购物中心":     "shopping",
		"交通设施服务;地铁站;地铁站":   "transport",
		"体育休闲服务;休闲场所;休闲场所": "entertainment",
		"科教文化服务;学校;高等院校":   "other",
		"":                 "other",
	}
	for in, want := range cases {
		if got := Category(in); got != want {
			t.Errorf("Category(%q) = %s, want %s", in, got, want)
		}
	}
}

func TestClientWithFakeServer(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Query().Get("key") != "k" {
			t.Errorf("missing key")
		}
		switch r.URL.Path {
		case "/v3/geocode/regeo":
			// Municipality: city comes back as [] and township as a string.
			_, _ = w.Write([]byte(`{"status":"1","info":"OK","regeocode":{"formatted_address":"北京市东城区东华门街道天安门",
				"addressComponent":{"province":"北京市","city":[],"district":"东城区","township":"东华门街道","adcode":"110101"}}}`))
		case "/v3/place/text":
			_, _ = w.Write([]byte(`{"status":"1","count":"1","pois":[{"id":"B000A","name":"楼外楼","type":"餐饮服务;中餐厅",
				"address":[],"location":"120.143,30.255","pname":"浙江省","cityname":"杭州市","adname":"西湖区","tel":[]}]}`))
		case "/v3/direction/walking":
			_, _ = w.Write([]byte(`{"status":"1","info":"ok","infocode":"10000","count":"1","route":{"origin":"120.151300,30.261000",
				"destination":"120.143700,30.255600","paths":[{"distance":"1234","duration":"987","steps":[]}]}}`))
		case "/v3/direction/driving":
			if q := r.URL.Query(); q.Get("extensions") != "base" || q.Get("strategy") != "0" {
				t.Errorf("driving query: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"status":"1","info":"OK","infocode":"10000","count":"1","route":{"taxi_cost":"20",
				"paths":[{"distance":"5321.6","duration":"600","strategy":"速度最快","steps":[]}]}}`))
		case "/v3/direction/transit/integrated":
			if q := r.URL.Query(); q.Get("city") != "杭州市" || q.Get("cityd") != "杭州市" {
				t.Errorf("transit query: %s", r.URL.RawQuery)
			}
			if r.URL.Query().Get("destination") == "120.151300,30.261000" { // no public transport
				_, _ = w.Write([]byte(`{"status":"1","info":"OK","infocode":"10000","count":"0","route":{"distance":"820","transits":[]}}`))
				return
			}
			// No distance of its own: the route's is used.
			_, _ = w.Write([]byte(`{"status":"1","info":"OK","infocode":"10000","count":"1","route":{"distance":"9000",
				"transits":[{"cost":"2","duration":"1800","walking_distance":"600","distance":[],"segments":[]}]}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := New("k")
	c.SetBaseURL(srv.URL)
	c.dirGap = time.Millisecond
	r, err := c.Regeo(context.Background(), 116.397, 39.908)
	if err != nil || r.City != "北京市" || r.District != "东城区" || r.Township != "东华门街道" {
		t.Fatalf("regeo: %+v %v", r, err)
	}
	if _, err := c.Regeo(context.Background(), 116.397, 39.908); err != nil || calls != 1 {
		t.Fatalf("regeo should be cached (calls=%d)", calls)
	}
	pois, err := c.Search(context.Background(), "楼外楼", "杭州", true, 5)
	if err != nil || len(pois) != 1 || pois[0].Category != "food" || pois[0].Address != "" || pois[0].Lng != 120.143 {
		t.Fatalf("search: %+v %v", pois, err)
	}

	ctx := context.Background()
	walk, err := c.Direction(ctx, "walking", 120.1513, 30.2610, 120.1437, 30.2556, "", "")
	if err != nil || *walk != (Route{Mode: "walking", DistanceM: 1234, DurationS: 987}) {
		t.Fatalf("walking: %+v %v", walk, err)
	}
	n := calls
	if r, err := c.Direction(ctx, "walking", 120.1513, 30.2610, 120.1437, 30.2556, "", ""); err != nil || r.DistanceM != 1234 || calls != n {
		t.Fatalf("walking should be cached: %+v %v (calls %d → %d)", r, err, n, calls)
	}
	drive, err := c.Direction(ctx, "driving", 120.1513, 30.2610, 120.1437, 30.2556, "", "")
	if err != nil || *drive != (Route{Mode: "driving", DistanceM: 5322, DurationS: 600}) {
		t.Fatalf("driving: %+v %v", drive, err)
	}
	bus, err := c.Direction(ctx, "transit", 120.1513, 30.2610, 120.1437, 30.2556, "杭州市", "杭州市")
	if err != nil || *bus != (Route{Mode: "transit", DistanceM: 9000, DurationS: 1800}) {
		t.Fatalf("transit: %+v %v", bus, err)
	}
	for i := 0; i < 2; i++ { // not cached: AMap is asked again
		n = calls
		if _, err := c.Direction(ctx, "transit", 120.1437, 30.2556, 120.1513, 30.2610, "杭州市", "杭州市"); !errors.Is(err, ErrNoRoute) || calls != n+1 {
			t.Fatalf("transit without a route: %v (calls %d → %d)", err, n, calls)
		}
	}
	if _, err := c.Direction(ctx, "cycling", 120.1513, 30.2610, 120.1437, 30.2556, "", ""); err == nil {
		t.Fatal("unknown mode accepted")
	}
}

// Direction requests are spaced out; callers whose turn is too far away give up at once.
func TestDirectionThrottle(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(`{"status":"1","route":{"paths":[{"distance":"100","duration":"80"}]}}`))
	}))
	defer srv.Close()
	c := New("k")
	c.SetBaseURL(srv.URL)
	c.dirGap, c.dirMaxWait = 200*time.Millisecond, 300*time.Millisecond
	ctx := context.Background()
	start := time.Now()
	for i := 0; i < 2; i++ {
		if _, err := c.Direction(ctx, "walking", 120, 30, 120.01+float64(i)/100, 30, "", ""); err != nil {
			t.Fatal(err)
		}
	}
	if d := time.Since(start); d < 190*time.Millisecond || calls.Load() != 2 {
		t.Fatalf("two requests took %v (%d sent)", d, calls.Load())
	}
	nextTurn := func(d time.Duration) {
		c.dirMu.Lock()
		c.dirNext = time.Now().Add(d)
		c.dirMu.Unlock()
	}
	// A turn beyond dirMaxWait: give up at once, without taking the turn.
	nextTurn(time.Second)
	begin := time.Now()
	if _, err := c.Direction(ctx, "walking", 121, 31, 121.01, 31, "", ""); !errors.Is(err, ErrUnavailable) || time.Since(begin) > 100*time.Millisecond {
		t.Fatalf("far turn: %v after %v", err, time.Since(begin))
	}
	c.dirMu.Lock()
	taken := c.dirNext.Sub(begin) > 1100*time.Millisecond
	c.dirMu.Unlock()
	if taken {
		t.Fatal("a caller that gave up took a turn")
	}
	// A caller that goes away while waiting for its turn returns at once.
	nextTurn(250 * time.Millisecond)
	cctx, cancel := context.WithTimeout(ctx, 20*time.Millisecond)
	defer cancel()
	begin = time.Now()
	if _, err := c.Direction(cctx, "walking", 121, 31, 121.01, 31, "", ""); !errors.Is(err, ErrUnavailable) || time.Since(begin) > 150*time.Millisecond {
		t.Fatalf("cancelled wait: %v after %v", err, time.Since(begin))
	}
	if calls.Load() != 2 {
		t.Fatalf("%d requests sent, want 2", calls.Load())
	}
}

// Running out of the 路径规划 quota pauses Direction only, not search.
func TestDirectionQuotaKeepsSearch(t *testing.T) {
	var mu sync.Mutex
	calls := map[string]int{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls[r.URL.Path]++
		mu.Unlock()
		if strings.HasPrefix(r.URL.Path, "/v3/direction/") {
			_, _ = w.Write([]byte(`{"status":"0","info":"DAILY_QUERY_OVER_LIMIT","infocode":"10003"}`))
			return
		}
		_, _ = w.Write([]byte(`{"status":"1","count":"0","pois":[]}`))
	}))
	defer srv.Close()
	c := New("k")
	c.SetBaseURL(srv.URL)
	c.dirGap = time.Millisecond
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		if _, err := c.Direction(ctx, "driving", 120, 30, 121, 31, "", ""); !errors.Is(err, ErrUnavailable) {
			t.Fatalf("direction %d: %v", i, err)
		}
	}
	for i := 0; i < 2; i++ {
		if _, err := c.Search(ctx, fmt.Sprintf("x%d", i), "", false, 5); err != nil {
			t.Fatalf("search after the direction quota ran out: %v", err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if calls["/v3/direction/driving"] != 1 || calls["/v3/place/text"] != 2 {
		t.Fatalf("requests: %v", calls)
	}
}

func TestDisabledAndUnreachable(t *testing.T) {
	if _, err := New("").Regeo(context.Background(), 120, 30); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("no key: %v", err)
	}
	c := New("k")
	c.SetBaseURL("http://127.0.0.1:1") // nothing listens here
	start := time.Now()
	if _, err := c.Search(context.Background(), "x", "", false, 5); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("unreachable: %v", err)
	}
	// The circuit breaker makes the next call fail instantly.
	if _, err := c.Search(context.Background(), "x", "", false, 5); !errors.Is(err, ErrUnavailable) || time.Since(start) > 3500*time.Millisecond {
		t.Fatalf("breaker: %v after %v", err, time.Since(start))
	}
}

func TestCallerCancelDoesNotTripBreaker(t *testing.T) {
	var mu sync.Mutex
	seen := map[string]bool{} // keywords that reached the server
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen[r.URL.Query().Get("keywords")] = true
		mu.Unlock()
		select {
		case <-time.After(400 * time.Millisecond):
		case <-r.Context().Done():
			return
		}
		_, _ = w.Write([]byte(`{"status":"1","count":"0","pois":[]}`))
	}))
	defer srv.Close()
	c := New("k")
	c.SetBaseURL(srv.URL)
	// The caller goes away (browser abort, client disconnect) mid-request.
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, cancel)
	if _, err := c.Search(ctx, "cancelled", "", false, 5); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("cancelled call: %v", err)
	}
	if _, err := c.Search(context.Background(), "after-cancel", "", false, 5); err != nil {
		t.Fatalf("a cancelled call must not trip the breaker: %v", err)
	}
	// Running out of time is an AMap problem and does trip it.
	tctx, tcancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer tcancel()
	if _, err := c.Search(tctx, "timeout", "", false, 5); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("timed-out call: %v", err)
	}
	if _, err := c.Search(context.Background(), "after-timeout", "", false, 5); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("breaker should be open after a timeout: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if seen["after-timeout"] {
		t.Fatal("the open breaker let a request through")
	}
}

func TestAPIErrorCodes(t *testing.T) {
	for _, tc := range []struct {
		code string
		trip bool
	}{
		{"10003", true},  // daily quota used up
		{"10009", true},  // key not for the Web 服务 platform
		{"10004", false}, // QPS limit: only this request failed
		{"20012", false}, // illegal content in this keyword
	} {
		var calls atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			_, _ = w.Write([]byte(`{"status":"0","info":"ERR","infocode":"` + tc.code + `"}`))
		}))
		c := New("k")
		c.SetBaseURL(srv.URL)
		if _, err := c.Search(context.Background(), "x", "", false, 5); !errors.Is(err, ErrUnavailable) || !strings.Contains(err.Error(), tc.code) {
			t.Fatalf("%s: %v", tc.code, err)
		}
		_, err := c.Search(context.Background(), "x", "", false, 5)
		if !errors.Is(err, ErrUnavailable) {
			t.Fatalf("%s: second call: %v", tc.code, err)
		}
		if reached := calls.Load() == 2; reached == tc.trip {
			t.Fatalf("%s: second call reached AMap=%v, want %v", tc.code, reached, !tc.trip)
		}
		srv.Close()
	}
}

func TestDetailAndPOICache(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		switch {
		case r.URL.Path == "/v3/place/detail" && r.URL.Query().Get("id") == "B0DETAIL":
			_, _ = w.Write([]byte(`{"status":"1","count":"1","pois":[{"id":"B0DETAIL","name":"楼外楼(孤山路店)","type":"餐饮服务;中餐厅",
				"address":"孤山路30号","location":"120.1437,30.2556","pname":"浙江省","cityname":"杭州市","adname":"西湖区","tel":"0571-1234"}]}`))
		case r.URL.Path == "/v3/place/text":
			_, _ = w.Write([]byte(`{"status":"1","count":"1","pois":[{"id":"B0SEARCH","name":"断桥残雪","type":"风景名胜",
				"address":[],"location":"120.1513,30.2610","pname":"浙江省","cityname":"杭州市","adname":"西湖区"}]}`))
		default:
			_, _ = w.Write([]byte(`{"status":"1","count":"0","pois":[]}`))
		}
	}))
	defer srv.Close()
	if _, ok := New("").CachedPOI("B0DETAIL"); ok {
		t.Fatal("disabled client has a cache hit")
	}
	c := New("k")
	c.SetBaseURL(srv.URL)
	if _, ok := c.CachedPOI("B0SEARCH"); ok {
		t.Fatal("unexpected cache hit")
	}
	if _, err := c.Search(context.Background(), "断桥", "", false, 5); err != nil {
		t.Fatal(err)
	}
	if p, ok := c.CachedPOI("B0SEARCH"); !ok || p.Name != "断桥残雪" || p.Category != "scenic" {
		t.Fatalf("search results should be cached: %+v %v", p, ok)
	}
	p, err := c.Detail(context.Background(), "B0DETAIL")
	if err != nil || p.Name != "楼外楼(孤山路店)" || p.Tel != "0571-1234" || p.City != "杭州市" || p.Lng != 120.1437 {
		t.Fatalf("detail: %+v %v", p, err)
	}
	n := calls.Load()
	if _, err := c.Detail(context.Background(), "B0DETAIL"); err != nil || calls.Load() != n {
		t.Fatalf("detail should be cached: %v (calls %d → %d)", err, n, calls.Load())
	}
	if _, err := c.Detail(context.Background(), "B0NOSUCH"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown id: %v", err)
	}
}

func TestSearchAndAroundCache(t *testing.T) {
	var mu sync.Mutex
	calls := map[string]int{} // requests per path
	locations := []string{}   // location parameters of around requests
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls[r.URL.Path]++
		if r.URL.Path == "/v3/place/around" {
			locations = append(locations, r.URL.Query().Get("location"))
		}
		mu.Unlock()
		_, _ = w.Write([]byte(`{"status":"1","count":"1","pois":[{"id":"B0CACHE","name":"知味观","type":"餐饮服务;中餐厅",
			"address":"仁和路83号","location":"120.1652,30.2547","pname":"浙江省","cityname":"杭州市","adname":"上城区","distance":"35"}]}`))
	}))
	defer srv.Close()
	c := New("k")
	c.SetBaseURL(srv.URL)
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		if ps, err := c.Search(ctx, "知味观", "杭州市", true, 5); err != nil || len(ps) != 1 || ps[0].Name != "知味观" {
			t.Fatalf("search %d: %+v %v", i, ps, err)
		}
	}
	if _, err := c.Search(ctx, "知味观", "杭州市", false, 5); err != nil {
		t.Fatal(err)
	}
	// Two points about 20 m apart share the ~100 m grid cell; other types are another query.
	for _, p := range [][2]float64{{120.14310, 30.25560}, {120.14325, 30.25570}} {
		if ps, err := c.Around(ctx, p[0], p[1], 2000, "050000", "", 15); err != nil || len(ps) != 1 {
			t.Fatalf("around %v: %+v %v", p, ps, err)
		}
	}
	if _, err := c.Around(ctx, 120.14310, 30.25560, 2000, "110000|140000", "", 15); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if calls["/v3/place/text"] != 2 || calls["/v3/place/around"] != 2 {
		t.Fatalf("requests: %v", calls)
	}
	if locations[0] != "120.143000,30.256000" {
		t.Fatalf("around should query the snapped point: %v", locations)
	}
	if _, ok := c.CachedPOI("B0CACHE"); !ok {
		t.Fatal("POIs of cached results should stay in the POI cache")
	}
}
