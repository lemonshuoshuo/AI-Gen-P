package handler

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
	"unicode"

	"github.com/gin-gonic/gin"

	"triphub/internal/amap"
	"triphub/internal/geo"
	"triphub/internal/model"
	"triphub/internal/tianditu"
)

// pickAddress is the address of a point picked on the map.
type pickAddress struct {
	Province string `json:"province"`
	City     string `json:"city"`
	District string `json:"district"`
	Street   string `json:"street"`
	Address  string `json:"address"`
}

// pickCandidate is one thing a map click may mean (GET /geo/pick).
type pickCandidate struct {
	// Kind: "aoi" (an area the point is in or near: scenic area, campus,
	// mall…), "poi" (a place nearby), "place" (a community place nearby) or
	// "address" (the clicked point itself).
	Kind      string      `json:"kind"`
	Name      string      `json:"name"`
	Address   string      `json:"address"`
	Category  string      `json:"category"`
	AmapID    string      `json:"amap_id"`
	PlaceID   *int64      `json:"place_id"`
	Lng       float64     `json:"lng"`
	Lat       float64     `json:"lat"`
	DistanceM int         `json:"distance_m"` // 0 for an AOI containing the point
	Place     *PlaceStats `json:"place"`      // community check-ins, like /geo/search items

	inside bool    // an AOI containing the point
	area   float64 // AOI area (m²)
	dist   float64
}

// Radii of GET /geo/pick (metres).
const (
	pickPOIRadius   = 200
	pickPlaceRadius = 150
	maxPickCands    = 20
)

// geoPick explains a click on the map: the areas it is in, the places
// around it (AMap, community places; Tianditu when AMap is unavailable) and
// finally the point itself as an address, so the route editor can name a
// waypoint "甲午岩景区" rather than "台州市".
func (h *Handler) geoPick(c *gin.Context) error {
	pos, err := positionFromQuery(c)
	if err != nil {
		return err
	}
	if pos == nil {
		return errBad("请提供 lng / lat")
	}
	if !h.geoLimit.Allow(fmt.Sprintf("u%d", currentUserID(c))) {
		return errTooMany("操作过于频繁，请稍后再试")
	}
	ctx := c.Request.Context()
	lng, lat := pos.Lng, pos.Lat
	var addr pickAddress
	if loc, ok := h.svc.Atlas.LookupGCJ(lng, lat); ok {
		addr.Province, addr.City = loc.Province, loc.City
	}
	var cands []pickCandidate
	source, amapErr := "local", ""
	var first, second string // parts of the address candidate's name

	if h.svc.Amap.Enabled() {
		actx, cancel := context.WithTimeout(ctx, geoTimeout)
		r, err := h.svc.Amap.RegeoDetail(actx, lng, lat)
		cancel()
		if err == nil {
			source = "amap"
			addr = mergeAddress(addr, pickAddress{Province: r.Province, City: r.City, District: r.District, Street: r.Township,
				Address: r.FormattedAddress})
			cands = amapCandidates(r, lng, lat)
			first, second = r.Township, r.Street
			if second == "" {
				second = r.Road
			}
		} else {
			amapErr = amapErrorText(err)
		}
	}
	if source == "local" && h.svc.Tianditu.Enabled() {
		tctx, cancel := context.WithTimeout(ctx, geoTimeout)
		r, err := h.svc.Tianditu.Regeo(tctx, lng, lat)
		cancel()
		if err == nil {
			source = "tianditu"
			addr = mergeAddress(addr, pickAddress{Province: r.Province, City: r.City, District: r.District, Street: r.Town,
				Address: r.Address})
			if r.POI != "" && (r.POIDistanceM < 0 || r.POIDistanceM <= pickPOIRadius) {
				// Tianditu gives the nearest POI's name and distance but not its
				// position: it is pinned at the clicked point.
				d := math.Max(r.POIDistanceM, 0)
				cands = append(cands, pickCandidate{Kind: "poi", Name: r.POI, Address: r.Nearby, Category: tianditu.Category(r.POI),
					Lng: geo.Round(lng, 6), Lat: geo.Round(lat, 6), DistanceM: int(math.Round(d)), dist: d})
			}
			first, second = r.Town, r.Road
		}
	}
	if first == "" {
		first = addr.District
	}

	places, err := h.nearbyVisiblePlaces(ctx, currentUser(c), lng, lat, pickPlaceRadius)
	if err != nil {
		return err
	}
	cands = mergePlaces(cands, places, lng, lat)
	h.attachPickStats(ctx, cands)
	cands = orderPick(cands)

	name := joinNonEmpty(" · ", first, second)
	if name == "" {
		name = joinNonEmpty("", addr.City, addr.District)
	}
	if name == "" {
		name = "未命名地点"
	}
	cands = append(cands, pickCandidate{Kind: "address", Name: name, Address: addr.Address, Category: "other",
		Lng: geo.Round(lng, 6), Lat: geo.Round(lat, 6)})
	c.JSON(http.StatusOK, withAmapError(gin.H{"address": addr, "candidates": cands, "source": source}, amapErr))
	return nil
}

// mergeAddress completes the address a from a map service with the
// offline atlas (base): a point in the sea has no province, and AMap then
// names the whole country ("中华人民共和国"), which is never taken for a
// province, city or address.
func mergeAddress(base, a pickAddress) pickAddress {
	for _, f := range []*string{&a.Province, &a.City, &a.District, &a.Address} {
		if amap.IsCountry(*f) {
			*f = ""
		}
	}
	if a.Province == "" {
		a.Province = base.Province
	}
	if a.City == "" {
		a.City = base.City
	}
	if a.Address == "" {
		a.Address = joinNonEmpty("", a.Province, a.City, a.District)
	}
	return a
}

func joinNonEmpty(sep string, parts ...string) string {
	var out []string
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" && (len(out) == 0 || out[len(out)-1] != p) {
			out = append(out, p)
		}
	}
	return strings.Join(out, sep)
}

// amapCandidates lists the AOIs and the POIs within pickPOIRadius of a
// detailed reverse geocoding result.
func amapCandidates(r *amap.RegeoDetail, lng, lat float64) []pickCandidate {
	var out []pickCandidate
	for _, a := range r.AOIs {
		d := math.Max(a.DistanceM, 0)
		out = append(out, pickCandidate{Kind: "aoi", Name: a.Name, Address: r.FormattedAddress, Category: a.Category,
			AmapID: a.ID, Lng: a.Lng, Lat: a.Lat, DistanceM: int(math.Round(d)), inside: a.DistanceM <= 0, area: a.AreaM2, dist: d})
	}
	for _, p := range r.POIs {
		d := p.Distance
		if d <= 0 { // not given: measure
			d = geo.Haversine(lng, lat, p.Lng, p.Lat)
		}
		if d > pickPOIRadius {
			continue
		}
		out = append(out, pickCandidate{Kind: "poi", Name: p.Name, Address: p.Address, Category: p.Category,
			AmapID: p.ID, Lng: p.Lng, Lat: p.Lat, DistanceM: int(math.Round(d)), dist: d})
	}
	return out
}

// nearbyVisiblePlaces returns the community places within radius metres of
// a point that the viewer may open (see visiblePlaceIDs), nearest first.
func (h *Handler) nearbyVisiblePlaces(ctx context.Context, viewer *model.User, lng, lat, radius float64) ([]model.Place, error) {
	minLng, minLat, maxLng, maxLat := geo.BBoxAround(lng, lat, radius)
	var places []model.Place
	if err := h.db.WithContext(ctx).Where("lng BETWEEN ? AND ? AND lat BETWEEN ? AND ?", minLng, maxLng, minLat, maxLat).
		Order("checkin_count DESC, id").Limit(200).Find(&places).Error; err != nil {
		return nil, err
	}
	ids := make([]int64, 0, len(places))
	for _, p := range places {
		if geo.Haversine(lng, lat, p.Lng, p.Lat) <= radius {
			ids = append(ids, p.ID)
		}
	}
	vis, err := h.visiblePlaceIDs(ctx, viewer, ids)
	if err != nil {
		return nil, err
	}
	out := places[:0]
	for _, p := range places {
		if vis[p.ID] {
			out = append(out, p)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		return geo.Haversine(lng, lat, out[i].Lng, out[i].Lat) < geo.Haversine(lng, lat, out[j].Lng, out[j].Lat)
	})
	return out, nil
}

// mergePlaces links community places to the AMap / Tianditu candidates they
// are (same amap_id, or same name) and adds the others as kind "place".
func mergePlaces(cands []pickCandidate, places []model.Place, lng, lat float64) []pickCandidate {
	for i := range places {
		p := &places[i]
		id := p.ID
		matched := false
		for j := range cands {
			if cands[j].PlaceID == nil && ((p.AmapID != "" && p.AmapID == cands[j].AmapID) || pickKey(p.Name) == pickKey(cands[j].Name)) {
				cands[j].PlaceID, matched = &id, true
				if cands[j].Address == "" {
					cands[j].Address = p.Address
				}
				break
			}
		}
		if matched {
			continue
		}
		d := geo.Haversine(lng, lat, p.Lng, p.Lat)
		cands = append(cands, pickCandidate{Kind: "place", Name: p.Name, Address: p.Address, Category: p.Category,
			AmapID: p.AmapID, PlaceID: &id, Lng: geo.Round(p.Lng, 6), Lat: geo.Round(p.Lat, 6), DistanceM: int(math.Round(d)), dist: d})
	}
	return cands
}

// attachPickStats sets the community statistics (and place_id) of
// candidates from AMap whose POI has a place with public check-ins, and of
// linked community places.
func (h *Handler) attachPickStats(ctx context.Context, cands []pickCandidate) {
	var amapIDs []string
	var placeIDs []int64
	for _, c := range cands {
		if c.AmapID != "" {
			amapIDs = append(amapIDs, c.AmapID)
		}
		if c.PlaceID != nil {
			placeIDs = append(placeIDs, *c.PlaceID)
		}
	}
	byAmap := h.placeStatsByAmapID(ctx, amapIDs)
	byID := map[int64]*PlaceStats{}
	var places []model.Place
	if len(placeIDs) > 0 && h.db.WithContext(ctx).Select(placeStatsColumns).
		Where("id IN ? AND checkin_count > 0", uniq(placeIDs)).Find(&places).Error == nil {
		for i := range places {
			byID[places[i].ID] = placeStats(&places[i])
		}
	}
	for i := range cands {
		c := &cands[i]
		if c.PlaceID != nil {
			c.Place = byID[*c.PlaceID]
		}
		if st := byAmap[c.AmapID]; c.Place == nil && st != nil && c.AmapID != "" {
			id := st.ID
			c.Place, c.PlaceID = st, &id
		}
	}
}

// orderPick sorts candidates: AOIs containing the point (smallest first),
// the other AOIs by distance, then POIs and places by distance; a name is
// listed once (the first wins).
func orderPick(cands []pickCandidate) []pickCandidate {
	group := func(c pickCandidate) int {
		switch {
		case c.Kind == "aoi" && c.inside:
			return 0
		case c.Kind == "aoi":
			return 1
		}
		return 2
	}
	sort.SliceStable(cands, func(i, j int) bool {
		a, b := cands[i], cands[j]
		if ga, gb := group(a), group(b); ga != gb {
			return ga < gb
		}
		if group(a) == 0 && a.area > 0 && b.area > 0 && a.area != b.area {
			return a.area < b.area
		}
		return a.dist < b.dist
	})
	seen := map[string]bool{}
	out := make([]pickCandidate, 0, len(cands))
	for _, c := range cands {
		k := pickKey(c.Name)
		if k == "" || seen[k] || len(out) >= maxPickCands {
			continue
		}
		seen[k] = true
		out = append(out, c)
	}
	return out
}

// pickKey compares names ignoring case, spaces and punctuation.
func pickKey(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if !unicode.IsSpace(r) && !unicode.IsPunct(r) && !unicode.IsSymbol(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}
