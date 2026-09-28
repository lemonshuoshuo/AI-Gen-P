package amap

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

// The search box merges place/text and input tips: 那海民宿 is only known to
// the tips, bus lines and keyword suggestions are dropped, the POI both
// return appears once, and exact / prefix name matches come first.
func TestFindMergesTips(t *testing.T) {
	var mu sync.Mutex
	queries := map[string]string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		mu.Lock()
		queries[r.URL.Path] = r.URL.RawQuery
		mu.Unlock()
		switch r.URL.Path {
		case "/v3/place/text":
			if q.Get("extensions") != "all" || q.Get("citylimit") != "false" || q.Get("city") != "台州市" || q.Get("offset") != "20" {
				t.Errorf("place/text query: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"status":"1","count":"3","infocode":"10000","pois":[
				{"id":"B0HOTEL001","name":"台州海景大酒店","type":"住宿服务;宾馆酒店;四星级宾馆","typecode":"100102","address":"海滨路1号",
				 "location":"121.440000,28.660000","pname":"浙江省","cityname":"台州市","adname":"椒江区",
				 "biz_ext":{"rating":"4.6","cost":"388.00"}},
				{"id":"B0SHARED01","name":"那海民宿(大陈岛店)","type":"住宿服务;旅馆招待所;旅馆招待所","typecode":"100200",
				 "address":"大陈镇","location":"121.900000,28.450000","pname":"浙江省","cityname":"台州市","adname":"椒江区",
				 "biz_ext":{"rating":[],"cost":[]}},
				{"id":"B0NOLOC001","name":"坏数据","location":[]}]}`))
		case "/v3/assistant/inputtips":
			if q.Get("datatype") != "all" || q.Get("citylimit") != "false" || q.Get("keywords") != "那海民宿" {
				t.Errorf("inputtips query: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"status":"1","count":"5","info":"OK","infocode":"10000","tips":[
				{"id":[],"name":"那海民宿怎么样","district":[],"adcode":[],"location":[],"address":[],"typecode":[]},
				{"id":"B0SHARED01","name":"那海民宿(大陈岛店)","district":"浙江省台州市椒江区","adcode":"331002",
				 "location":"121.900000,28.450000","address":"大陈镇","typecode":"100200"},
				{"id":"B0TIPONLY1","name":"那海民宿","district":"浙江省台州市椒江区","adcode":"331002",
				 "location":"121.910000,28.460000","address":"下大陈","typecode":"100200"},
				{"id":"330100010947","name":"那海专线(公交)","district":"浙江省台州市","adcode":"331000","location":[],"address":"大陈;那海","typecode":[]},
				{"id":"B0FOOD0001","name":"老那海海鲜","district":"浙江省台州市椒江区","adcode":"331002",
				 "location":"121.905,28.455","address":[],"typecode":"050100"}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := New("k")
	c.SetBaseURL(srv.URL)
	ps, err := c.Find(context.Background(), "那海民宿", "台州市", 20)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, p := range ps {
		names = append(names, p.Name)
	}
	if strings.Join(names, ",") != "那海民宿,那海民宿(大陈岛店),台州海景大酒店,老那海海鲜" {
		t.Fatalf("merged order: %v", names)
	}
	exact := ps[0]
	if exact.ID != "B0TIPONLY1" || exact.Province != "浙江省" || exact.City != "台州市" || exact.District != "椒江区" ||
		exact.Category != "hotel" || exact.Lng != 121.91 || exact.Address != "下大陈" {
		t.Fatalf("tip converted: %+v", exact)
	}
	if ps[1].Type == "" || ps[1].Rating != 0 {
		t.Fatalf("the shared POI keeps place/text data: %+v", ps[1])
	}
	if ps[2].Rating != 4.6 || ps[2].Cost != 388 || ps[3].Category != "food" {
		t.Fatalf("business details / typecode category: %+v %+v", ps[2], ps[3])
	}
	if _, ok := c.CachedPOI("B0TIPONLY1"); !ok {
		t.Fatal("tip POIs must be remembered for WarmPOI")
	}
	mu.Lock()
	n := len(queries)
	queries = map[string]string{}
	mu.Unlock()
	if n != 2 {
		t.Fatalf("both APIs should be asked: %d", n)
	}
	if _, err := c.Find(context.Background(), "那海民宿", "台州市", 20); err != nil || len(queries) != 0 {
		t.Fatalf("Find should be cached: %v %v", err, queries)
	}
}

func TestNameRankAndSplitRegion(t *testing.T) {
	p := POI{Name: "那海民宿", City: "台州市", District: "椒江区"}
	for kw, want := range map[string]int{"那海民宿": 0, "那海": 1, "台州那海民宿": 0, "台州市那海": 1, "椒江那海民宿": 0, "民宿": 2, "那 海 民宿": 0} {
		if got := nameRank(kw, p); got != want {
			t.Errorf("nameRank(%q) = %d, want %d", kw, got, want)
		}
	}
	for in, want := range map[string][3]string{
		"浙江省台州市椒江区":        {"浙江省", "台州市", "椒江区"},
		"北京市东城区":           {"北京市", "北京市", "东城区"},
		"新疆维吾尔自治区乌鲁木齐市天山区": {"新疆维吾尔自治区", "乌鲁木齐市", "天山区"},
		"吉林省延边朝鲜族自治州延吉市":   {"吉林省", "延边朝鲜族自治州", "延吉市"},
		"湖北省神农架林区":         {"湖北省", "", "神农架林区"},
		"":                 {"", "", ""},
	} {
		p, c, d := SplitRegion(in)
		if [3]string{p, c, d} != want {
			t.Errorf("SplitRegion(%q) = %q %q %q, want %v", in, p, c, d, want)
		}
	}
}

// One of the two requests failing still gives results; both failing
// reports the error.
func TestFindPartialFailure(t *testing.T) {
	var tipsDown atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/v3/assistant/inputtips" && tipsDown.Load():
			_, _ = w.Write([]byte(`{"status":"0","info":"ACCESS_TOO_FREQUENT","infocode":"10004"}`))
		case r.URL.Path == "/v3/assistant/inputtips":
			_, _ = w.Write([]byte(`{"status":"1","tips":[{"id":"B0T","name":"小店","location":"120.1,30.2","district":"浙江省杭州市西湖区"}]}`))
		default:
			_, _ = w.Write([]byte(`{"status":"0","info":"ACCESS_TOO_FREQUENT","infocode":"10004"}`))
		}
	}))
	defer srv.Close()
	c := New("k")
	c.SetBaseURL(srv.URL)
	ps, err := c.Find(context.Background(), "小店", "", 10)
	if err != nil || len(ps) != 1 || ps[0].ID != "B0T" {
		t.Fatalf("partial: %+v %v", ps, err)
	}
	tipsDown.Store(true)
	// Not cached (one request failed): asked again, now both fail.
	_, err = c.Find(context.Background(), "小店", "", 10)
	if !errors.Is(err, ErrUnavailable) || ErrorCode(err) != "10004" || !strings.Contains(ErrorMessage(err), "过于频繁") {
		t.Fatalf("both failed: %v", err)
	}
}

func TestErrorMessages(t *testing.T) {
	for code, want := range map[string]string{
		"10001": "高德 Key 无效（infocode 10001 INVALID_USER_KEY）：请检查 .env 中的 AMAP_KEY 是否完整、没有多余的引号、空格或注释",
		"10009": "高德 Key 的服务平台不是「Web服务」：请在高德控制台为本站创建服务平台为「Web服务」的 Key",
		"10005": "服务器 IP 不在高德 Key 的白名单中（infocode 10005）：在高德控制台把服务器公网 IP 加入白名单，或清空白名单",
		"10003": "高德调用额度已用完（infocode 10003），次日零点恢复，或在控制台提升配额",
		"10044": "高德调用额度已用完（infocode 10044），次日零点恢复，或在控制台提升配额",
		"10041": "高德调用额度已用完（或该接口的使用权限已过期）",
		"10007": "高德 Key 开启了数字签名（infocode 10007 INVALID_USER_SIGNATURE）：本站不支持签名，请在控制台关闭该 Key 的数字签名",
		"10012": "该 Key 没有此接口权限（infocode 10012）",
		"40000": "高德付费额度已用完（infocode 40000 QUOTA_PLAN_RUN_OUT），请在控制台续费或提升配额",
		"30001": "高德服务内部错误（infocode 30001 UNKNOWN_ERROR），请稍后再试",
		"20003": "高德接口返回错误（infocode 20003 UNKNOWN_ERROR）",
	} {
		info := "UNKNOWN_ERROR"
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"status":"0","info":"` + info + `","infocode":"` + code + `"}`))
		}))
		c := New("k")
		c.SetBaseURL(srv.URL)
		_, err := c.Find(context.Background(), "x", "", 5)
		if msg := ErrorMessage(err); msg != want || ErrorCode(err) != code {
			t.Errorf("%s: %q, want %q", code, msg, want)
		}
		// Key errors pause calls; the paused calls report the same problem.
		_, err = c.Search(context.Background(), "y", "", false, 5)
		if keyErrors[code] {
			if msg := ErrorMessage(err); !strings.HasPrefix(msg, want) || !strings.Contains(msg, "暂停") || c.LastError() == nil {
				t.Errorf("%s while paused: %q", code, msg)
			}
		} else if ErrorMessage(err) != want || c.LastError() != nil {
			t.Errorf("%s must not pause: %v", code, err)
		}
		srv.Close()
	}
	c := New("k")
	c.SetBaseURL("http://127.0.0.1:1")
	_, err := c.Find(context.Background(), "x", "", 5)
	if msg := ErrorMessage(err); msg != "服务器无法连接高德（127.0.0.1:1）：TCP 连接 127.0.0.1:1 失败：连接被拒绝（connection refused）" {
		t.Fatalf("network: %q", msg)
	}
	if d := Details(err); d.Layer != "connect" || !strings.Contains(d.Detail, "connection refused") || strings.Contains(d.Detail, "?") {
		t.Fatalf("network details: %+v", d)
	}
	if strings.Contains(err.Error(), "key=k") {
		t.Fatalf("the key leaked: %v", err)
	}
	if msg := ErrorMessage(ErrUnavailable); msg != "" {
		t.Fatalf("no key configured is not an error to report: %q", msg)
	}
	if _, err := New("").Find(context.Background(), "x", "", 5); !errors.Is(err, ErrUnavailable) || ErrorMessage(err) != "" {
		t.Fatalf("disabled: %v", err)
	}
}

func TestCheckBypassesBreaker(t *testing.T) {
	var fail atomic.Bool
	fail.Store(true)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail.Load() {
			_, _ = w.Write([]byte(`{"status":"0","info":"USERKEY_PLAT_NOMATCH","infocode":"10009"}`))
			return
		}
		if r.URL.Path == "/v3/place/text" && r.URL.Query().Get("keywords") == "天安门" && r.URL.Query().Get("city") == "北京" {
			_, _ = w.Write([]byte(`{"status":"1","count":"1","pois":[{"id":"B000A60DA1","name":"天安门","location":"116.397,39.909"}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"status":"1","count":"0","pois":[]}`))
	}))
	defer srv.Close()
	c := New("k")
	c.SetBaseURL(srv.URL)
	if _, err := c.Search(context.Background(), "x", "", false, 5); ErrorCode(err) != "10009" {
		t.Fatalf("first: %v", err)
	}
	if err := c.Check(context.Background()); ErrorCode(err) != "10009" {
		t.Fatalf("check while paused must still ask AMap: %v", err)
	}
	fail.Store(false)
	if err := c.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Search(context.Background(), "x", "", false, 5); err != nil {
		t.Fatalf("a successful check lifts the pause: %v", err)
	}
}

func TestRegeoDetail(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		q := r.URL.Query()
		if r.URL.Path != "/v3/geocode/regeo" || q.Get("extensions") != "all" || q.Get("radius") != "200" || q.Get("roadlevel") != "0" {
			t.Errorf("regeo query: %s %s", r.URL.Path, r.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`{"status":"1","info":"OK","infocode":"10000","regeocode":{
			"formatted_address":"浙江省台州市椒江区大陈镇甲午岩景区",
			"addressComponent":{"province":"浙江省","city":"台州市","district":"椒江区","township":"大陈镇","adcode":"331002",
				"neighborhood":{"name":[],"type":[]},"building":{"name":[],"type":[]},
				"streetNumber":{"street":"环岛公路","number":"8号","location":"121.9,28.45","direction":"东","distance":"40.1"},
				"businessAreas":[[]]},
			"roads":[{"id":"1","name":"远路","distance":"150","direction":"北","location":"121.9,28.45"},
			         {"id":"2","name":"环岛公路","distance":"30.5","direction":"东","location":"121.9,28.45"}],
			"roadinters":[],
			"pois":[{"id":"B0POI00002","name":"观海亭","type":"风景名胜;风景名胜相关;旅游景点","tel":[],"direction":"西","distance":"25.3",
			          "location":"121.9002,28.4501","address":"甲午岩景区内","poiweight":"0.2","businessarea":[]},
			        {"id":"B0POI00001","name":"甲午岩停车场","type":"交通设施服务;停车场;停车场","tel":[],"direction":"北","distance":"80",
			          "location":"121.901,28.451","address":[],"poiweight":"0.1","businessarea":[]}],
			"aois":[{"id":"B0AOI00001","name":"大陈岛","adcode":"331002","location":"121.89,28.44","area":"12000000","distance":"0","type":"110000"},
			        {"id":"B0AOI00002","name":"甲午岩景区","adcode":"331002","location":"121.9001,28.4502","area":"250000.5","distance":"0","type":"110202"},
			        {"id":"B0AOI00003","name":"渔港","location":"121.95,28.46","area":"5000","distance":"120","type":"150000"}]}}`))
	}))
	defer srv.Close()
	c := New("k")
	c.SetBaseURL(srv.URL)
	r, err := c.RegeoDetail(context.Background(), 121.9, 28.45)
	if err != nil {
		t.Fatal(err)
	}
	if r.Province != "浙江省" || r.City != "台州市" || r.District != "椒江区" || r.Township != "大陈镇" || r.Street != "环岛公路" ||
		r.Number != "8号" || r.Road != "环岛公路" || len(r.AOIs) != 3 || len(r.POIs) != 2 {
		t.Fatalf("detail: %+v", r)
	}
	if a := r.AOIs[1]; a.Name != "甲午岩景区" || a.DistanceM != 0 || a.AreaM2 != 250000.5 || a.Category != "scenic" || a.Lng != 121.9001 {
		t.Fatalf("aoi: %+v", a)
	}
	if p := r.POIs[0]; p.Name != "观海亭" || p.Distance != 25.3 || p.Category != "scenic" || p.City != "台州市" || p.District != "椒江区" {
		t.Fatalf("poi: %+v", p)
	}
	// The smallest AOI containing the point names it.
	if s := r.Spot(30); s != "甲午岩景区" {
		t.Fatalf("spot: %q", s)
	}
	if _, err := c.RegeoDetail(context.Background(), 121.9, 28.45); err != nil || calls.Load() != 1 {
		t.Fatalf("cached: %v (%d calls)", err, calls.Load())
	}
	outside := &RegeoDetail{AOIs: []AOI{{Name: "渔港", DistanceM: 120}}, POIs: []POI{{Name: "远", Distance: 31}, {Name: "近", Distance: 12}}}
	if s := outside.Spot(30); s != "近" {
		t.Fatalf("nearest POI within 30 m: %q", s)
	}
	if s := (&RegeoDetail{POIs: []POI{{Name: "远", Distance: 31}}}).Spot(30); s != "" {
		t.Fatalf("nothing close: %q", s)
	}
}
