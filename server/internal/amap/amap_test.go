package amap

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
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
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := New("k")
	c.SetBaseURL(srv.URL)
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
