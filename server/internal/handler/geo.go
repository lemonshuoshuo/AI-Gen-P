package handler

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"triphub/internal/amap"
	"triphub/internal/geo"
	"triphub/internal/model"
)

type geoItem struct {
	AmapID   string      `json:"amap_id"`
	Name     string      `json:"name"`
	Address  string      `json:"address"`
	Province string      `json:"province"`
	City     string      `json:"city"`
	District string      `json:"district"`
	Category string      `json:"category"`
	Lng      float64     `json:"lng"`
	Lat      float64     `json:"lat"`
	Place    *PlaceStats `json:"place"` // community check-ins of the POI, if any
}

func poiItem(p amap.POI) geoItem {
	return geoItem{AmapID: p.ID, Name: p.Name, Address: p.Address, Province: p.Province,
		City: p.City, District: p.District, Category: p.Category, Lng: p.Lng, Lat: p.Lat}
}

// attachPlaceStats sets Place on the items whose AMap POI has public
// check-ins: a picked result links to the place with its amap_id (see
// service.ResolvePlace), so its community verdicts show before anyone goes
// there. The items are still returned if this lookup fails.
func (h *Handler) attachPlaceStats(ctx context.Context, items []geoItem) {
	var ids []string
	for _, it := range items {
		if it.AmapID != "" {
			ids = append(ids, it.AmapID)
		}
	}
	var places []model.Place
	if len(ids) == 0 || h.db.WithContext(ctx).Select(placeStatsColumns).
		Where("amap_id IN ? AND amap_id <> '' AND checkin_count > 0", ids).Find(&places).Error != nil {
		return
	}
	stats := make(map[string]*PlaceStats, len(places))
	for i := range places {
		stats[places[i].AmapID] = placeStats(&places[i])
	}
	for i := range items {
		items[i].Place = stats[items[i].AmapID]
	}
}

// aroundItem is a GET /geo/around result: a POI and its distance in metres
// from the requested point.
type aroundItem struct {
	geoItem
	DistanceM int `json:"distance_m"`
}

// geoAround lists the AMap POIs (shops, restaurants, sights...) around a
// point, nearest first, so that a check-in is pinned to the actual shop
// rather than a bare coordinate. source is "none" (no items) when no AMap
// key is configured.
func (h *Handler) geoAround(c *gin.Context) error {
	pos, err := positionFromQuery(c)
	if err != nil {
		return err
	}
	if pos == nil {
		return errBad("请提供 lng / lat")
	}
	kw, err := clean(c.Query("keyword"), "关键词", 50, false)
	if err != nil {
		return err
	}
	radius := 300
	if v, ok := queryFloat(c, "radius"); ok && v > 0 {
		radius = int(math.Max(50, math.Min(v, 5000)))
	}
	if !h.svc.Amap.Enabled() {
		c.JSON(http.StatusOK, gin.H{"source": "none", "items": []aroundItem{}})
		return nil
	}
	if !h.geoLimit.Allow(fmt.Sprintf("u%d", currentUserID(c))) {
		return errTooMany("搜索过于频繁，请稍后再试")
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
	pois, err := h.svc.Amap.Around(ctx, pos.Lng, pos.Lat, radius, "", kw, 20)
	cancel()
	if err != nil {
		return &apiError{http.StatusInternalServerError, "internal", "周边地点暂时无法获取，请稍后再试"}
	}
	base := make([]geoItem, 0, len(pois))
	for _, p := range pois {
		base = append(base, poiItem(p))
	}
	h.attachPlaceStats(c.Request.Context(), base)
	items := make([]aroundItem, 0, len(base))
	for _, it := range base {
		// AMap measures from the point snapped to its cache grid: measure from the request.
		items = append(items, aroundItem{geoItem: it, DistanceM: int(math.Round(geo.Haversine(pos.Lng, pos.Lat, it.Lng, it.Lat)))})
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].DistanceM < items[j].DistanceM })
	c.JSON(http.StatusOK, gin.H{"source": "amap", "items": items})
	return nil
}

func (h *Handler) geoSearch(c *gin.Context) error {
	kw, err := clean(c.Query("keyword"), "关键词", 50, true)
	if err != nil {
		return err
	}
	city := strings.TrimSpace(c.Query("city"))
	pos, err := positionFromQuery(c)
	if err != nil {
		return err
	}
	if !h.geoLimit.Allow(fmt.Sprintf("u%d", currentUserID(c))) {
		return errTooMany("搜索过于频繁，请稍后再试")
	}
	if h.svc.Amap.Enabled() {
		cityHint := city
		if cityHint == "" && pos != nil {
			if loc, ok := h.svc.Atlas.LookupGCJ(pos.Lng, pos.Lat); ok {
				cityHint = loc.City
			}
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
		pois, err := h.svc.Amap.Search(ctx, kw, cityHint, false, 20)
		cancel()
		if err == nil {
			items := make([]geoItem, 0, len(pois))
			for _, p := range pois {
				items = append(items, poiItem(p))
			}
			h.attachPlaceStats(c.Request.Context(), items)
			c.JSON(http.StatusOK, gin.H{"source": "amap", "items": items})
			return nil
		}
	}
	matches := h.svc.Atlas.Search(kw, 10)
	items := make([]geoItem, 0, len(matches))
	for _, m := range matches {
		items = append(items, geoItem{Name: m.Name, Province: m.Province, City: m.City, Category: "other", Lng: m.Lng, Lat: m.Lat})
	}
	c.JSON(http.StatusOK, gin.H{"source": "local", "items": items})
	return nil
}

func (h *Handler) geoRegeo(c *gin.Context) error {
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
	info := h.svc.Locate(c.Request.Context(), pos.Lng, pos.Lat, true)
	c.JSON(http.StatusOK, gin.H{
		"province": info.Province, "province_code": info.ProvinceCode, "city": info.City, "city_code": info.CityCode,
		"district": info.District, "street": info.Street, "address": info.Address,
		"lng": geo.Round(pos.Lng, 6), "lat": geo.Round(pos.Lat, 6),
	})
	return nil
}

// geoAtlas serves the embedded TopoJSON (gzip-compressed when accepted).
func (h *Handler) geoAtlas(c *gin.Context) {
	h.atlasOnce.Do(func() {
		raw := geo.AtlasJSON()
		sum := sha256.Sum256(raw)
		h.atlasETag = `"` + hex.EncodeToString(sum[:8]) + `"`
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
		_, _ = zw.Write(raw)
		_ = zw.Close()
		h.atlasGz = buf.Bytes()
	})
	hd := c.Writer.Header()
	hd.Set("Cache-Control", "public, max-age=86400")
	hd.Set("ETag", h.atlasETag)
	addVary(hd, "Accept-Encoding")
	if c.GetHeader("If-None-Match") == h.atlasETag {
		c.Status(http.StatusNotModified)
		return
	}
	if acceptsGzip(c.GetHeader("Accept-Encoding")) {
		hd.Set("Content-Encoding", "gzip")
		c.Data(http.StatusOK, "application/json", h.atlasGz)
		return
	}
	c.Data(http.StatusOK, "application/json", geo.AtlasJSON())
}
