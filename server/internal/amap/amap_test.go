package amap

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
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
	same := func(r *Route, mode string, dist, dur int) bool {
		return r != nil && r.Mode == mode && r.DistanceM == dist && r.DurationS == dur
	}
	walk, err := c.Direction(ctx, "walking", 120.1513, 30.2610, 120.1437, 30.2556, "", "")
	if err != nil || !same(walk, "walking", 1234, 987) || walk.Polyline() != nil {
		t.Fatalf("walking: %+v %v", walk, err)
	}
	n := calls
	if r, err := c.Direction(ctx, "walking", 120.1513, 30.2610, 120.1437, 30.2556, "", ""); err != nil || r.DistanceM != 1234 || calls != n {
		t.Fatalf("walking should be cached: %+v %v (calls %d → %d)", r, err, n, calls)
	}
	drive, err := c.Direction(ctx, "driving", 120.1513, 30.2610, 120.1437, 30.2556, "", "")
	if err != nil || !same(drive, "driving", 5322, 600) {
		t.Fatalf("driving: %+v %v", drive, err)
	}
	bus, err := c.Direction(ctx, "transit", 120.1513, 30.2610, 120.1437, 30.2556, "杭州市", "杭州市")
	if err != nil || !same(bus, "transit", 9000, 1800) {
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

// Routes keep their way, simplified, from the start to the end point:
// walking and driving steps, riding (the v4 API, errcode instead of
// status), and public transport (walks, bus lines, train stations).
func TestDirectionGeometry(t *testing.T) {
	var riding atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v3/direction/walking":
			// A straight street sampled every ~1 m (simplified away) with a corner.
			var b strings.Builder
			for i := 0; i <= 100; i++ {
				if i > 0 {
					b.WriteString(";")
				}
				fmt.Fprintf(&b, "%.6f,30.250000", 120.1+float64(i)*0.00001)
			}
			_, _ = fmt.Fprintf(w, `{"status":"1","route":{"paths":[{"distance":"300","duration":"250","steps":[
				{"polyline":"%s"},{"polyline":"120.101000,30.250000;120.101000,30.252000"}]}]}}`, b.String())
		case "/v3/direction/driving":
			_, _ = w.Write([]byte(`{"status":"1","route":{"paths":[{"distance":"5000","duration":"600","steps":[
				{"polyline":"120.100000,30.250000;120.120000,30.260000"},{"polyline":[]},{"polyline":"120.120000,30.260000;120.140000,30.250000"}]}]}}`))
		case "/v4/direction/bicycling":
			if riding.Add(1) == 1 {
				_, _ = w.Write([]byte(`{"data":{"origin":"120.1,30.25","destination":"120.14,30.25","paths":[{"distance":4100,"duration":1100,
					"steps":[{"polyline":"120.100000,30.250000;120.110000,30.255000"},{"polyline":"120.110000,30.255000;120.140000,30.250000"}]}]},
					"errcode":0,"errdetail":null,"errmsg":"OK"}`))
				return
			}
			_, _ = w.Write([]byte(`{"errcode":10001,"errmsg":"INVALID_USER_KEY","errdetail":null,"data":""}`))
		case "/v3/direction/transit/integrated":
			_, _ = w.Write([]byte(`{"status":"1","route":{"distance":"30000","transits":[{"distance":"29000","duration":"3600","segments":[
				{"walking":{"steps":[{"polyline":"120.100000,30.250000;120.101000,30.251000"}]},"bus":{"buslines":[{"polyline":"120.101000,30.251000;120.200000,30.300000"}]},"railway":[]},
				{"walking":[],"bus":{"buslines":[]},"railway":{"departure_stop":{"location":"120.200000,30.300000"},"via_stops":[{"location":"120.250000,30.400000"}],"arrival_stop":{"location":"120.300000,30.450000"}}}
			]}]}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := New("k")
	c.SetBaseURL(srv.URL)
	c.dirGap = time.Millisecond
	ctx := context.Background()

	walk, err := c.Direction(ctx, "walking", 120.1, 30.25, 120.101, 30.252, "", "")
	if err != nil {
		t.Fatal(err)
	}
	want := [][2]float64{{120.1, 30.25}, {120.101, 30.25}, {120.101, 30.252}}
	if got := walk.Polyline(); !reflect.DeepEqual(got, want) {
		t.Fatalf("walking polyline %v, want %v", got, want)
	}
	drive, err := c.Direction(ctx, "driving", 120.1, 30.25, 120.14, 30.25, "", "")
	if err != nil || len(drive.Polyline()) != 3 || drive.Polyline()[1] != [2]float64{120.12, 30.26} {
		t.Fatalf("driving: %+v %v", drive, err)
	}
	ride, err := c.Direction(ctx, "riding", 120.1, 30.25, 120.14, 30.25, "", "")
	if err != nil || ride.Mode != "riding" || ride.DistanceM != 4100 || ride.DurationS != 1100 || len(ride.Polyline()) != 3 {
		t.Fatalf("riding: %+v %v", ride, err)
	}
	if r, ok := c.CachedDirection("riding", 120.1, 30.25, 120.14, 30.25, "", ""); !ok || r != ride {
		t.Fatal("riding route not cached")
	}
	// v4 errors carry the infocode: a key error pauses 路径规划.
	if _, err := c.Direction(ctx, "riding", 120.1, 30.25, 120.15, 30.25, "", ""); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("riding error: %v", err)
	} else if msg := ErrorMessage(err); !strings.Contains(msg, "10001") {
		t.Fatalf("riding error message: %s", msg)
	}
	c.dirFail.close()
	bus, err := c.Direction(ctx, "transit", 120.1, 30.25, 120.3, 30.45, "杭州市", "杭州市")
	if err != nil || bus.DistanceM != 29000 {
		t.Fatalf("transit: %+v %v", bus, err)
	}
	pl := bus.Polyline()
	if pl[0] != [2]float64{120.1, 30.25} || pl[len(pl)-1] != [2]float64{120.3, 30.45} || !slices.Contains(pl, [2]float64{120.25, 30.4}) {
		t.Fatalf("transit polyline %v", pl)
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
	if _, err := c.Direction(ctx, "walking", 121, 31, 121.01, 31, "", ""); !errors.Is(err, ErrBusy) || !errors.Is(err, ErrUnavailable) ||
		time.Since(begin) > 100*time.Millisecond {
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
	c.netGap = 0                       // count failures however close together
	for i := range netFailLimit {
		_, err := c.Search(context.Background(), fmt.Sprint("x", i), "", false, 5)
		var e *Error
		if !errors.As(err, &e) || e.Paused || !e.Network || e.Layer() != "connect" {
			t.Fatalf("unreachable #%d: %v", i, err)
		}
		if (i < netFailLimit-1) != (c.LastError() == nil) {
			t.Fatalf("after %d failures in a row the breaker is open: %v", i+1, c.LastError())
		}
	}
	// Paused: the next call fails at once and says why.
	_, err := c.Search(context.Background(), "y", "", false, 5)
	var e *Error
	if !errors.As(err, &e) || !e.Paused || !strings.Contains(ErrorMessage(err), "已暂停调用高德") {
		t.Fatalf("breaker: %v", err)
	}
	if until := time.Unix(0, c.fail.until.Load()); time.Until(until) > netPause || time.Until(until) < netPause-5*time.Second {
		t.Fatalf("paused until %v", until)
	}
}

// A failure between successes does not add up: the count restarts after
// every answer.
func TestNetworkFailuresResetOnSuccess(t *testing.T) {
	var down atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if down.Load() {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		_, _ = w.Write([]byte(`{"status":"1","count":"0","pois":[]}`))
	}))
	defer srv.Close()
	c := New("k")
	c.SetBaseURL(srv.URL)
	c.netGap = 0
	for i := range 3 * netFailLimit {
		down.Store(i%2 == 0) // fail, succeed, fail…
		_, err := c.Search(context.Background(), fmt.Sprint("q", i), "", false, 5)
		if (err != nil) != (i%2 == 0) || c.LastError() != nil {
			t.Fatalf("call %d: %v, paused: %v", i, err, c.LastError())
		}
	}
	down.Store(true)
	for i := range netFailLimit {
		_, _ = c.Search(context.Background(), fmt.Sprint("d", i), "", false, 5)
	}
	var e *Error
	if !errors.As(c.LastError(), &e) || e.HTTPStatus != http.StatusBadGateway || !strings.Contains(e.Message(), "HTTP 502") {
		t.Fatalf("%d failures in a row: %v", netFailLimit, c.LastError())
	}
	// The admin check closes the breaker once AMap answers again.
	down.Store(false)
	if err := c.Check(context.Background()); err != nil || c.LastError() != nil {
		t.Fatalf("check: %v, paused: %v", err, c.LastError())
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
	// A caller deadline shorter than the client's timeout (the 3 s of
	// Locate, recommendations…) ends requests without counting: AMap was not
	// given the time a request may take.
	cut := func(kw string) error {
		tctx, tcancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		defer tcancel()
		_, err := c.Search(tctx, kw, "", false, 5)
		return err
	}
	c.netGap = 0
	for i := range 2 * netFailLimit {
		err := cut(fmt.Sprint("cut", i))
		var e *Error
		if !errors.As(err, &e) || e.Paused || e.Layer() != "timeout" || !strings.HasPrefix(e.Message(), "高德接口响应超时") {
			t.Fatalf("cut call %d: %v", i, err)
		}
	}
	if c.LastError() != nil {
		t.Fatalf("calls cut short by their caller must not pause AMap: %v", c.LastError())
	}
	// Running out of the client's own time counts as an AMap failure, but a
	// single slow request does not pause AMap for everyone.
	c.http.Timeout = 100 * time.Millisecond
	timeout := func(kw string) error {
		_, err := c.Search(context.Background(), kw, "", false, 5)
		return err
	}
	err := timeout("timeout")
	var e *Error
	if !errors.As(err, &e) || e.Layer() != "timeout" || !strings.HasPrefix(e.Message(), "高德接口响应超时") {
		t.Fatalf("timed-out call: %v", err)
	}
	c.http.Timeout = RequestTimeout
	if _, err := c.Search(context.Background(), "after-timeout", "", false, 5); err != nil {
		t.Fatalf("one timeout must not open the breaker: %v", err)
	}
	// Several in a row do.
	c.http.Timeout = 100 * time.Millisecond
	for i := range netFailLimit {
		if err := timeout(fmt.Sprint("timeout", i)); !errors.Is(err, ErrUnavailable) {
			t.Fatalf("timed-out call: %v", err)
		}
	}
	if _, err := c.Search(context.Background(), "after-timeouts", "", false, 5); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("breaker should be open after %d timeouts in a row: %v", netFailLimit, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if seen["after-timeouts"] {
		t.Fatal("the open breaker let a request through")
	}
}

// Failures count once per moment: Find's two parallel requests failing
// together are one failure, so one slow search and one slow reverse
// geocoding do not pause AMap; requests started before the last answer or
// breaker change do not count at all.
func TestNetworkFailuresCountOncePerMoment(t *testing.T) {
	block := make(chan struct{})
	defer close(block)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select { // never answers in time
		case <-block:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	c := New("k")
	c.SetBaseURL(srv.URL)
	c.http.Timeout = 100 * time.Millisecond
	c.netGap = 50 * time.Millisecond
	if _, err := c.Find(context.Background(), "慢", "", 5); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("find: %v", err)
	}
	if n := c.streak.n; n != 1 {
		t.Fatalf("a failed Find counts once, got %d", n)
	}
	if _, err := c.Regeo(context.Background(), 121.9, 28.4); !errors.Is(err, ErrUnavailable) || c.LastError() != nil {
		t.Fatalf("one slow search and one slow regeo must not pause AMap: %v, paused: %v", err, c.LastError())
	}
	if _, err := c.Find(context.Background(), "慢2", "", 5); !errors.Is(err, ErrUnavailable) || c.LastError() == nil {
		t.Fatalf("a third failure at another moment pauses AMap: %v, paused: %v", err, c.LastError())
	}
}

func TestNetStreak(t *testing.T) {
	var s netStreak
	gap := time.Second
	now := time.Now()
	for i, tc := range []struct {
		start   time.Time
		n       int
		counted bool
	}{
		{now, 1, true},
		{now.Add(300 * time.Millisecond), 1, false}, // same moment (a parallel request)
		{now.Add(-300 * time.Millisecond), 1, false},
		{now.Add(1500 * time.Millisecond), 2, true},
		{now.Add(3 * time.Second), 3, true},
	} {
		if n, counted := s.fail(tc.start, gap); n != tc.n || counted != tc.counted {
			t.Fatalf("#%d: %d %v, want %d %v", i, n, counted, tc.n, tc.counted)
		}
	}
	before := time.Now().Add(-time.Millisecond)
	s.reset()
	// Still in flight when AMap answered (or the breaker opened): not counted.
	if n, counted := s.fail(before, gap); n != 0 || counted {
		t.Fatalf("a request started before the reset counted: %d %v", n, counted)
	}
	if n, counted := s.fail(time.Now(), gap); n != 1 || !counted {
		t.Fatalf("after the reset: %d %v", n, counted)
	}
}

// A 200 answer that is not AMap's JSON (a captive portal, a proxy or WAF
// page) is explained, and counts like a network failure.
func TestNotAnAmapAnswer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<html><head><title>Portal Login</title></head><body>key=` + r.URL.Query().Get("key") + `</body></html>`))
	}))
	defer srv.Close()
	c := New("0123456789abcdef0123456789abcdef")
	c.SetBaseURL(srv.URL)
	c.netGap = 0
	_, err := c.Search(context.Background(), "x", "", false, 5)
	var e *Error
	if !errors.As(err, &e) || !e.BadReply || e.Layer() != "response" {
		t.Fatalf("html answer: %v", err)
	}
	d := Details(err)
	if d.Layer != "response" || !d.Blocked || d.Detail != "HTML 页面「Portal Login」" {
		t.Fatalf("details: %+v", d)
	}
	if msg := e.Message(); !strings.Contains(msg, "不是高德的数据") || strings.Contains(msg, "Key 无效") {
		t.Fatalf("message: %q", msg)
	}
	for i := range netFailLimit - 1 {
		_, _ = c.Search(context.Background(), fmt.Sprint("y", i), "", false, 5)
	}
	if c.LastError() == nil {
		t.Fatal("answers that are not AMap's count towards pausing it")
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

// AMap answers points in the sea with the country as province and address:
// that is no place, the fields are left empty for the atlas to fill.
func TestRegeoSea(t *testing.T) {
	for _, body := range []string{
		`{"status":"1","info":"OK","infocode":"10000","regeocode":{"formatted_address":"中华人民共和国",
			"addressComponent":{"country":"中国","province":"中华人民共和国","city":[],"citycode":[],"district":[],"adcode":"100000",
			"township":[],"towncode":[],"streetNumber":{"street":[],"number":[]}},
			"pois":[{"id":"B0SEA","name":"海上风电场","type":"公司企业;公司;公司","distance":"150","location":"121.907,28.456","address":[]}],
			"roads":[],"aois":[]}}`,
		`{"status":"1","info":"OK","infocode":"10000","regeocode":{"formatted_address":[],
			"addressComponent":{"country":[],"province":[],"city":[],"district":[],"adcode":[],"township":[]},"pois":[],"roads":[],"aois":[]}}`,
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(body)) }))
		c := New("k")
		c.SetBaseURL(srv.URL)
		r, err := c.Regeo(context.Background(), 121.9063, 28.4556)
		if err != nil || r.Province != "" || r.City != "" || r.FormattedAddress != "" || r.Adcode != "" {
			t.Fatalf("regeo: %+v %v", r, err)
		}
		d, err := c.RegeoDetail(context.Background(), 121.9063, 28.4556)
		if err != nil || d.Province != "" || d.City != "" || d.FormattedAddress != "" {
			t.Fatalf("regeo detail: %+v %v", d, err)
		}
		if strings.Contains(body, "B0SEA") && (len(d.POIs) != 1 || d.POIs[0].Name != "海上风电场" || d.POIs[0].City != "") {
			t.Fatalf("nearby POIs are kept: %+v", d.POIs)
		}
		srv.Close()
	}
	if !IsCountry(" 中华人民共和国 ") || IsCountry("浙江省") {
		t.Fatal("IsCountry")
	}
}
