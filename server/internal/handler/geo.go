package handler

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

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
			var ids []string
			for _, p := range pois {
				items = append(items, geoItem{AmapID: p.ID, Name: p.Name, Address: p.Address, Province: p.Province,
					City: p.City, District: p.District, Category: p.Category, Lng: p.Lng, Lat: p.Lat})
				if p.ID != "" {
					ids = append(ids, p.ID)
				}
			}
			// A picked result links to the place with its amap_id (see
			// service.ResolvePlace): show that place's community verdicts.
			// Search results are still returned if this lookup fails.
			var places []model.Place
			if len(ids) > 0 && h.db.WithContext(c.Request.Context()).Select(placeStatsColumns).
				Where("amap_id IN ? AND amap_id <> '' AND checkin_count > 0", ids).Find(&places).Error == nil {
				stats := make(map[string]*PlaceStats, len(places))
				for i := range places {
					stats[places[i].AmapID] = placeStats(&places[i])
				}
				for i := range items {
					items[i].Place = stats[items[i].AmapID]
				}
			}
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
