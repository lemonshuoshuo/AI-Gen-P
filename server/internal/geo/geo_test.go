package geo

import (
	"math"
	"testing"
)

func TestGCJRoundTrip(t *testing.T) {
	cases := []Point{
		{120.15, 30.28}, {116.397, 39.908}, {121.4737, 31.2304}, {113.2644, 23.1291},
		{87.6168, 43.8256}, {91.1409, 29.6456}, {126.642, 45.757}, {110.33, 20.03},
	}
	for _, c := range cases {
		gLng, gLat := WGS84ToGCJ02(c.Lng, c.Lat)
		if d := Haversine(c.Lng, c.Lat, gLng, gLat); d < 50 || d > 1000 {
			t.Errorf("%v: GCJ offset %.1fm looks wrong", c, d)
		}
		wLng, wLat := GCJ02ToWGS84(gLng, gLat)
		if d := Haversine(c.Lng, c.Lat, wLng, wLat); d > 1 {
			t.Errorf("%v: round trip error %.3fm >= 1m", c, d)
		}
	}
}

func TestOutOfChinaPassthrough(t *testing.T) {
	for _, c := range []Point{{-0.1276, 51.5072}, {139.6917, 35.6895}, {151.2093, -33.8688}} {
		lng, lat := WGS84ToGCJ02(c.Lng, c.Lat)
		if lng != c.Lng || lat != c.Lat {
			t.Errorf("%v should pass through, got %v,%v", c, lng, lat)
		}
		lng, lat = GCJ02ToWGS84(c.Lng, c.Lat)
		if lng != c.Lng || lat != c.Lat {
			t.Errorf("%v should pass through inverse, got %v,%v", c, lng, lat)
		}
	}
}

// Neighbouring countries inside the OutOfChina box use WGS-84 on 高德 / Apple
// maps too: no offset either way.
func TestGCJForeignPassthrough(t *testing.T) {
	cases := map[string]Point{
		"首尔": {126.978, 37.5665}, "釜山": {129.0756, 35.1796}, "大阪": {135.5023, 34.6937}, "福冈": {130.4017, 33.5902},
		"那霸": {127.6809, 26.2124}, "河内": {105.8342, 21.0278}, "胡志明市": {106.6297, 10.8231}, "曼谷": {100.5018, 13.7563},
		"新加坡": {103.8198, 1.3521}, "吉隆坡": {101.6869, 3.139}, "马尼拉": {120.9842, 14.5995}, "乌兰巴托": {106.9057, 47.8864},
		"符拉迪沃斯托克": {131.8869, 43.1155}, "加德满都": {85.324, 27.7172}, "阿拉木图": {76.8512, 43.222},
	}
	for name, c := range cases {
		if lng, lat := WGS84ToGCJ02(c.Lng, c.Lat); lng != c.Lng || lat != c.Lat {
			t.Errorf("%s %v should pass through, got %v,%v", name, c, lng, lat)
		}
		if lng, lat := GCJ02ToWGS84(c.Lng, c.Lat); lng != c.Lng || lat != c.Lat {
			t.Errorf("%s %v should pass through inverse, got %v,%v", name, c, lng, lat)
		}
	}
}

// Chinese border towns and islands next to the excluded areas keep the offset.
func TestGCJBorderAndIslands(t *testing.T) {
	cases := map[string]Point{
		"丹东": {124.3545, 40.0}, "珲春": {130.3659, 42.8624}, "黑河": {127.499, 50.245}, "漠河": {122.5361, 52.9721},
		"满洲里": {117.4432, 49.5978}, "二连浩特": {111.9771, 43.6532}, "喀什": {75.9897, 39.4677}, "樟木": {85.98, 27.99},
		"瑞丽": {97.8519, 24.0129}, "磨憨": {101.5566, 21.1827}, "河口": {103.9392, 22.5293}, "东兴": {107.97, 21.54},
		"三亚": {109.5119, 18.2528}, "永兴岛": {112.3364, 16.8339}, "香港": {114.1694, 22.3193}, "澳门": {113.5439, 22.1987},
		"台北": {121.5654, 25.033}, "钓鱼岛": {123.4760, 25.7440}, "赤尾屿": {124.5570, 25.9230}, "黄岩岛": {117.7500, 15.1500},
		"曾母暗沙": {112.2830, 3.9700},
	}
	for name, c := range cases {
		gLng, gLat := WGS84ToGCJ02(c.Lng, c.Lat)
		if d := Haversine(c.Lng, c.Lat, gLng, gLat); d < 50 || d > 1000 {
			t.Errorf("%s %v: GCJ offset %.1fm looks wrong", name, c, d)
		}
		wLng, wLat := GCJ02ToWGS84(gLng, gLat)
		if d := Haversine(c.Lng, c.Lat, wLng, wLat); d > 1 {
			t.Errorf("%s %v: round trip error %.3fm >= 1m", name, c, d)
		}
	}
}

// No excluded area reaches Chinese territory (Lookup also snaps points up to
// 12 km outside the simplified borders).
func TestGCJExcludeAvoidsChina(t *testing.T) {
	a, err := DefaultAtlas()
	if err != nil {
		t.Fatal(err)
	}
	const step = 0.05
	for _, b := range gcjExclude {
		for x := b[0]; x <= b[2]+1e-9; x += step {
			for y := b[1]; y <= b[3]+1e-9; y += step {
				if loc, ok := a.Lookup(x, y); ok {
					t.Fatalf("excluded area %v covers (%.3f, %.3f) in %s%s", b, x, y, loc.Province, loc.City)
				}
			}
		}
	}
}

func TestHaversine(t *testing.T) {
	// Beijing Tiananmen → Shanghai People's Square ≈ 1067 km.
	d := Haversine(116.3975, 39.9087, 121.4737, 31.2304)
	if math.Abs(d-1067000) > 5000 {
		t.Errorf("Beijing-Shanghai distance %.0f", d)
	}
	// 0.001° of latitude ≈ 111 m.
	if d := Haversine(120, 30, 120, 30.001); math.Abs(d-111.2) > 0.5 {
		t.Errorf("small distance %.2f", d)
	}
	if Haversine(120, 30, 120, 30) != 0 {
		t.Error("zero distance expected")
	}
}

func TestSimplify(t *testing.T) {
	// A straight line with tiny jitter collapses to its endpoints.
	var line []Point
	for i := 0; i <= 100; i++ {
		jitter := 0.0
		if i%2 == 1 {
			jitter = 0.000005 // ≈0.5 m
		}
		line = append(line, Point{120 + float64(i)*0.001, 30 + jitter})
	}
	got := Simplify(line, 5)
	if len(got) != 2 {
		t.Fatalf("expected 2 points, got %d", len(got))
	}
	// An L-shape keeps the corner.
	var l []Point
	for i := 0; i <= 10; i++ {
		l = append(l, Point{120 + float64(i)*0.001, 30})
	}
	for i := 1; i <= 10; i++ {
		l = append(l, Point{120.01, 30 + float64(i)*0.001})
	}
	idx := SimplifyIndices(l, 5)
	if len(idx) != 3 || idx[1] != 10 {
		t.Fatalf("expected corner to be kept, got %v", idx)
	}
	if n := len(Simplify(l[:2], 5)); n != 2 {
		t.Fatalf("two points should be kept, got %d", n)
	}
}

func TestAtlasLookup(t *testing.T) {
	a, err := DefaultAtlas()
	if err != nil {
		t.Fatal(err)
	}
	if len(a.provList) != 34 || len(a.prefList) != 372 {
		t.Fatalf("unexpected region counts %d/%d", len(a.provList), len(a.prefList))
	}
	cases := []struct {
		lng, lat       float64
		province, city string
	}{
		{120.15, 30.28, "浙江省", "杭州市"},
		{116.40, 39.91, "北京市", "北京市"},
		{121.47, 31.23, "上海市", "上海市"},
		{113.26, 23.13, "广东省", "广州市"},
		{104.07, 30.67, "四川省", "成都市"},
		{114.17, 22.30, "香港特别行政区", "香港特别行政区"},
		{121.50, 25.04, "台湾省", "台湾省"},
	}
	for _, c := range cases {
		loc, ok := a.LookupGCJ(c.lng, c.lat)
		if !ok || loc.Province != c.province || loc.City != c.city {
			t.Errorf("(%v,%v) → %+v ok=%v, want %s/%s", c.lng, c.lat, loc, ok, c.province, c.city)
		}
	}
	if loc, ok := a.LookupGCJ(120.15, 30.28); !ok || loc.ProvinceCode != "330000" || loc.CityCode != "330100" {
		t.Errorf("codes wrong: %+v", loc)
	}
	for _, p := range []Point{{125.0, 20.0}, {150.0, 30.0}, {-73.98, 40.75}} {
		if loc, ok := a.LookupGCJ(p.Lng, p.Lat); ok {
			t.Errorf("ocean/foreign point %v resolved to %+v", p, loc)
		}
	}
}

func TestAtlasSearch(t *testing.T) {
	a, err := DefaultAtlas()
	if err != nil {
		t.Fatal(err)
	}
	res := a.Search("杭州", 5)
	if len(res) == 0 || res[0].Name != "杭州市" || res[0].Province != "浙江省" || res[0].City != "杭州市" {
		t.Fatalf("search 杭州: %+v", res)
	}
	if loc, ok := a.LookupGCJ(res[0].Lng, res[0].Lat); !ok || loc.City != "杭州市" {
		t.Errorf("label point of 杭州市 not inside: %+v", loc)
	}
	res = a.Search("北京", 5)
	if len(res) != 1 || res[0].Name != "北京市" || res[0].City != "北京市" {
		t.Fatalf("search 北京: %+v", res)
	}
	res = a.Search("浙江", 5)
	if len(res) == 0 || res[0].Name != "浙江省" || res[0].City != "" {
		t.Fatalf("search 浙江: %+v", res)
	}
	if res := a.Search("杭州西湖", 5); len(res) == 0 || res[0].Name != "杭州市" {
		t.Fatalf("search 杭州西湖: %+v", res)
	}
	if res := a.Search("zzzz", 5); len(res) != 0 {
		t.Fatalf("unexpected results %+v", res)
	}
}

func BenchmarkLookup(b *testing.B) {
	a, _ := DefaultAtlas()
	for i := 0; i < b.N; i++ {
		a.LookupGCJ(120.15, 30.28)
	}
}
