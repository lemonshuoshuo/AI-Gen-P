package geo

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"
)

//go:embed data/cn-atlas.json
var atlasData []byte

// AtlasJSON returns the raw embedded TopoJSON (objects provinces / prefectures / nation).
func AtlasJSON() []byte { return atlasData }

type ring []Point
type polygon []ring // first ring is the outer boundary, following rings are holes

// Region is a province or prefecture-level division. Coordinates are WGS-84.
type Region struct {
	Code         string
	Name         string
	ProvinceCode string
	ProvinceName string
	Level        int // 1 = province, 2 = prefecture

	polys                          []polygon
	minLng, minLat, maxLng, maxLat float64
	label                          Point
}

// Label returns a representative point inside the region (WGS-84).
func (r *Region) Label() Point { return r.label }

// Location is the result of an atlas lookup.
type Location struct {
	ProvinceCode string `json:"province_code"`
	Province     string `json:"province"`
	CityCode     string `json:"city_code"`
	City         string `json:"city"`
}

// Atlas provides point-in-polygon lookups for provinces and prefectures.
type Atlas struct {
	provinces   map[string]*Region
	prefectures map[string]*Region
	provList    []*Region
	prefList    []*Region
	grid        map[[2]int][]*Region
}

var (
	defaultAtlas *Atlas
	atlasOnce    sync.Once
	atlasErr     error
)

// DefaultAtlas parses the embedded atlas once and returns it.
func DefaultAtlas() (*Atlas, error) {
	atlasOnce.Do(func() {
		defaultAtlas, atlasErr = ParseAtlas(atlasData)
	})
	return defaultAtlas, atlasErr
}

type topoJSON struct {
	Arcs      [][][]float64 `json:"arcs"`
	Transform *struct {
		Scale     [2]float64 `json:"scale"`
		Translate [2]float64 `json:"translate"`
	} `json:"transform"`
	Objects map[string]struct {
		Geometries []topoGeom `json:"geometries"`
	} `json:"objects"`
}

type topoGeom struct {
	Type       string          `json:"type"`
	Arcs       json.RawMessage `json:"arcs"`
	Properties map[string]any  `json:"properties"`
}

// ParseAtlas decodes a TopoJSON topology with "provinces" and "prefectures" objects.
func ParseAtlas(data []byte) (*Atlas, error) {
	var t topoJSON
	if err := json.Unmarshal(data, &t); err != nil {
		return nil, fmt.Errorf("parse atlas: %w", err)
	}
	arcs := make([][]Point, len(t.Arcs))
	for i, a := range t.Arcs {
		pts := make([]Point, len(a))
		x, y := 0.0, 0.0
		for j, p := range a {
			if len(p) < 2 {
				return nil, errors.New("parse atlas: bad arc point")
			}
			if t.Transform != nil {
				x += p[0]
				y += p[1]
				pts[j] = Point{x*t.Transform.Scale[0] + t.Transform.Translate[0], y*t.Transform.Scale[1] + t.Transform.Translate[1]}
			} else {
				pts[j] = Point{p[0], p[1]}
			}
		}
		arcs[i] = pts
	}

	a := &Atlas{
		provinces:   map[string]*Region{},
		prefectures: map[string]*Region{},
		grid:        map[[2]int][]*Region{},
	}
	build := func(obj string, level int) ([]*Region, error) {
		o, ok := t.Objects[obj]
		if !ok {
			return nil, fmt.Errorf("parse atlas: object %q missing", obj)
		}
		var out []*Region
		for _, g := range o.Geometries {
			polys, err := decodeGeometry(g, arcs)
			if err != nil {
				return nil, err
			}
			if len(polys) == 0 {
				continue
			}
			r := &Region{
				Code:  propString(g.Properties, "id"),
				Name:  propString(g.Properties, "地名"),
				Level: level,
				polys: polys,
			}
			r.computeBBox()
			r.label = labelPoint(polys)
			out = append(out, r)
		}
		return out, nil
	}
	var err error
	if a.provList, err = build("provinces", 1); err != nil {
		return nil, err
	}
	if a.prefList, err = build("prefectures", 2); err != nil {
		return nil, err
	}
	for _, r := range a.provList {
		r.ProvinceCode, r.ProvinceName = r.Code, r.Name
		a.provinces[r.Code] = r
	}
	for _, r := range a.prefList {
		r.ProvinceCode = ProvinceCodeOf(r.Code)
		if p, ok := a.provinces[r.ProvinceCode]; ok {
			r.ProvinceName = p.Name
		}
		a.prefectures[r.Code] = r
		for x := int(math.Floor(r.minLng)); x <= int(math.Floor(r.maxLng)); x++ {
			for y := int(math.Floor(r.minLat)); y <= int(math.Floor(r.maxLat)); y++ {
				k := [2]int{x, y}
				a.grid[k] = append(a.grid[k], r)
			}
		}
	}
	return a, nil
}

// ProvinceCodeOf returns the province code for a 6-digit division code.
func ProvinceCodeOf(code string) string {
	if len(code) < 2 {
		return ""
	}
	return code[:2] + "0000"
}

func propString(m map[string]any, key string) string {
	if v, ok := m[key]; ok {
		switch s := v.(type) {
		case string:
			return s
		case float64:
			return fmt.Sprintf("%.0f", s)
		}
	}
	return ""
}

func decodeGeometry(g topoGeom, arcs [][]Point) ([]polygon, error) {
	switch g.Type {
	case "Polygon":
		var rings [][]int
		if err := json.Unmarshal(g.Arcs, &rings); err != nil {
			return nil, err
		}
		return []polygon{buildPolygon(rings, arcs)}, nil
	case "MultiPolygon":
		var polys [][][]int
		if err := json.Unmarshal(g.Arcs, &polys); err != nil {
			return nil, err
		}
		out := make([]polygon, 0, len(polys))
		for _, p := range polys {
			out = append(out, buildPolygon(p, arcs))
		}
		return out, nil
	default:
		return nil, nil
	}
}

func buildPolygon(rings [][]int, arcs [][]Point) polygon {
	pg := make(polygon, 0, len(rings))
	for _, idx := range rings {
		var r ring
		for k, i := range idx {
			reversed := i < 0
			if reversed {
				i = ^i
			}
			if i >= len(arcs) {
				continue
			}
			a := arcs[i]
			n := len(a)
			for j := 0; j < n; j++ {
				if k > 0 && j == 0 {
					continue // shared endpoint with the previous arc
				}
				if reversed {
					r = append(r, a[n-1-j])
				} else {
					r = append(r, a[j])
				}
			}
		}
		if len(r) >= 3 {
			pg = append(pg, r)
		}
	}
	return pg
}

func (r *Region) computeBBox() {
	r.minLng, r.minLat = math.Inf(1), math.Inf(1)
	r.maxLng, r.maxLat = math.Inf(-1), math.Inf(-1)
	for _, pg := range r.polys {
		for _, rg := range pg {
			for _, p := range rg {
				r.minLng = math.Min(r.minLng, p.Lng)
				r.minLat = math.Min(r.minLat, p.Lat)
				r.maxLng = math.Max(r.maxLng, p.Lng)
				r.maxLat = math.Max(r.maxLat, p.Lat)
			}
		}
	}
}

func (pg polygon) contains(x, y float64) bool {
	in := false
	for _, r := range pg {
		n := len(r)
		for i, j := 0, n-1; i < n; j, i = i, i+1 {
			xi, yi := r[i].Lng, r[i].Lat
			xj, yj := r[j].Lng, r[j].Lat
			if (yi > y) != (yj > y) && x < (xj-xi)*(y-yi)/(yj-yi)+xi {
				in = !in
			}
		}
	}
	return in
}

// Contains reports whether the WGS-84 point lies inside the region.
func (r *Region) Contains(lng, lat float64) bool {
	if lng < r.minLng || lng > r.maxLng || lat < r.minLat || lat > r.maxLat {
		return false
	}
	for _, pg := range r.polys {
		if pg.contains(lng, lat) {
			return true
		}
	}
	return false
}

// distanceTo returns the approximate distance in metres from a point to the region boundary.
func (r *Region) distanceTo(lng, lat float64) float64 {
	kx := 111320.0 * math.Cos(lat*math.Pi/180)
	ky := 110540.0
	best := math.Inf(1)
	for _, pg := range r.polys {
		for _, rg := range pg {
			n := len(rg)
			for i, j := 0, n-1; i < n; j, i = i, i+1 {
				d := segDist2(lng*kx, lat*ky, rg[j].Lng*kx, rg[j].Lat*ky, rg[i].Lng*kx, rg[i].Lat*ky)
				if d < best {
					best = d
				}
			}
		}
	}
	return math.Sqrt(best)
}

// labelPoint finds a point guaranteed to be inside the largest polygon: the
// midpoint of the widest interior run of a horizontal line through the
// polygon's area centroid.
func labelPoint(polys []polygon) Point {
	var best polygon
	bestArea := -1.0
	for _, pg := range polys {
		if len(pg) == 0 {
			continue
		}
		if a := math.Abs(ringArea(pg[0])); a > bestArea {
			best, bestArea = pg, a
		}
	}
	if best == nil {
		return Point{}
	}
	c := ringCentroid(best[0])
	y := c.Lat
	var xs []float64
	for _, r := range best {
		n := len(r)
		for i, j := 0, n-1; i < n; j, i = i, i+1 {
			yi, yj := r[i].Lat, r[j].Lat
			if (yi > y) != (yj > y) {
				xs = append(xs, (r[j].Lng-r[i].Lng)*(y-yi)/(yj-yi)+r[i].Lng)
			}
		}
	}
	sort.Float64s(xs)
	bestW := -1.0
	out := c
	for i := 0; i+1 < len(xs); i += 2 {
		if w := xs[i+1] - xs[i]; w > bestW {
			bestW = w
			out = Point{(xs[i] + xs[i+1]) / 2, y}
		}
	}
	// Prefer the true centroid when it is inside (looks more natural).
	if best.contains(c.Lng, c.Lat) {
		return c
	}
	return out
}

func ringArea(r ring) float64 {
	s := 0.0
	for i, j := 0, len(r)-1; i < len(r); j, i = i, i+1 {
		s += r[j].Lng*r[i].Lat - r[i].Lng*r[j].Lat
	}
	return s / 2
}

func ringCentroid(r ring) Point {
	a := ringArea(r)
	if a == 0 {
		return r[0]
	}
	cx, cy := 0.0, 0.0
	for i, j := 0, len(r)-1; i < len(r); j, i = i, i+1 {
		f := r[j].Lng*r[i].Lat - r[i].Lng*r[j].Lat
		cx += (r[j].Lng + r[i].Lng) * f
		cy += (r[j].Lat + r[i].Lat) * f
	}
	return Point{cx / (6 * a), cy / (6 * a)}
}

// maxSnapDistance is how far outside any polygon a point may lie and still be
// assigned to the nearest prefecture (coastlines are simplified in the atlas).
const maxSnapDistance = 12000.0

// Lookup finds the province and prefecture containing a WGS-84 point.
func (a *Atlas) Lookup(lng, lat float64) (Location, bool) {
	if a == nil || !ValidCoord(lng, lat) {
		return Location{}, false
	}
	cell := [2]int{int(math.Floor(lng)), int(math.Floor(lat))}
	for _, r := range a.grid[cell] {
		if r.Contains(lng, lat) {
			return a.locationOf(r), true
		}
	}
	// Snap to the nearest prefecture for points just outside simplified borders.
	var best *Region
	bestD := maxSnapDistance
	const pad = 0.15
	for _, r := range a.prefList {
		if lng < r.minLng-pad || lng > r.maxLng+pad || lat < r.minLat-pad || lat > r.maxLat+pad {
			continue
		}
		if d := r.distanceTo(lng, lat); d < bestD {
			best, bestD = r, d
		}
	}
	if best != nil {
		return a.locationOf(best), true
	}
	return Location{}, false
}

// LookupGCJ is Lookup for a GCJ-02 coordinate.
func (a *Atlas) LookupGCJ(lng, lat float64) (Location, bool) {
	wLng, wLat := GCJ02ToWGS84(lng, lat)
	return a.Lookup(wLng, wLat)
}

func (a *Atlas) locationOf(r *Region) Location {
	return Location{ProvinceCode: r.ProvinceCode, Province: r.ProvinceName, CityCode: r.Code, City: r.Name}
}

// Province returns the province region by code.
func (a *Atlas) Province(code string) *Region { return a.provinces[code] }

// Prefecture returns the prefecture region by code.
func (a *Atlas) Prefecture(code string) *Region { return a.prefectures[code] }

// AreaMatch is a province/prefecture matched by name. Lng/Lat are GCJ-02.
type AreaMatch struct {
	Code         string
	Name         string
	Level        int
	Province     string
	ProvinceCode string
	City         string
	CityCode     string
	Lng, Lat     float64
}

var nameSuffixes = []string{"特别行政区", "维吾尔自治区", "壮族自治区", "回族自治区", "自治区", "自治州", "地区", "林区", "盟", "省", "市", "州", "县"}

// BaseName strips administrative suffixes such as 省/市/自治区 from a name.
func BaseName(name string) string {
	for _, s := range nameSuffixes {
		if strings.HasSuffix(name, s) {
			b := strings.TrimSuffix(name, s)
			if utf8.RuneCountInString(b) >= 2 {
				return b
			}
		}
	}
	return name
}

// Search matches province and prefecture names against a keyword
// ("杭州" → 杭州市) and returns their label points in GCJ-02.
func (a *Atlas) Search(keyword string, limit int) []AreaMatch {
	kw := strings.TrimSpace(keyword)
	if a == nil || kw == "" {
		return nil
	}
	type scored struct {
		r     *Region
		score int
	}
	var hits []scored
	score := func(r *Region) int {
		base := BaseName(r.Name)
		switch {
		case r.Name == kw || base == kw:
			return 0
		case strings.HasPrefix(r.Name, kw):
			return 1
		case strings.Contains(r.Name, kw):
			return 2
		case utf8.RuneCountInString(base) >= 2 && strings.Contains(kw, base):
			return 3
		}
		return -1
	}
	seen := map[string]bool{}
	// Prefectures first so that municipalities resolve to the city entry.
	for _, r := range a.prefList {
		if s := score(r); s >= 0 {
			hits = append(hits, scored{r, s*2 + 1})
			seen[r.Code] = true
		}
	}
	for _, r := range a.provList {
		if seen[r.Code] {
			continue
		}
		if s := score(r); s >= 0 {
			hits = append(hits, scored{r, s * 2})
		}
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].score < hits[j].score })
	if limit > 0 && len(hits) > limit {
		hits = hits[:limit]
	}
	out := make([]AreaMatch, 0, len(hits))
	for _, h := range hits {
		lng, lat := WGS84ToGCJ02(h.r.label.Lng, h.r.label.Lat)
		m := AreaMatch{Code: h.r.Code, Name: h.r.Name, Level: h.r.Level, Province: h.r.ProvinceName,
			ProvinceCode: h.r.ProvinceCode, Lng: Round(lng, 6), Lat: Round(lat, 6)}
		if h.r.Level == 2 {
			m.City, m.CityCode = h.r.Name, h.r.Code
		}
		out = append(out, m)
	}
	return out
}
