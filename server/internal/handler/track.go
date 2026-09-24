package handler

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"triphub/internal/geo"
	"triphub/internal/model"
	"triphub/internal/service"
)

const maxTrackPointsPerRequest = 1000

func (h *Handler) appendTrack(c *gin.Context) error {
	t, _, err := h.tripForEdit(c)
	if err != nil {
		return err
	}
	var req struct {
		CoordType string `json:"coord_type"`
		Segment   int    `json:"segment"`
		Points    []struct {
			Lng   float64 `json:"lng"`
			Lat   float64 `json:"lat"`
			Alt   float64 `json:"alt"`
			Acc   float64 `json:"acc"`
			Speed float64 `json:"speed"`
			T     int64   `json:"t"`
		} `json:"points"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	if len(req.Points) == 0 {
		return errBad("points 不能为空")
	}
	if len(req.Points) > maxTrackPointsPerRequest {
		return errBad("单次最多上传 1000 个轨迹点")
	}
	if req.Segment < 0 || req.Segment > 100000 {
		return errBad("segment 无效")
	}
	ct, err := coordType(req.CoordType, "gcj02")
	if err != nil {
		return err
	}
	uid := currentUserID(c)
	minT := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	maxT := time.Now().Add(24 * time.Hour).UnixMilli()
	rows := make([]model.TrackPoint, 0, len(req.Points))
	for _, p := range req.Points {
		if !geo.ValidCoord(p.Lng, p.Lat) || p.T < minT || p.T > maxT {
			continue // drop malformed samples instead of failing the batch
		}
		lng, lat := geo.ToGCJ02(p.Lng, p.Lat, ct)
		rows = append(rows, model.TrackPoint{
			TripID: t.ID, UserID: uid, Segment: req.Segment, Lng: geo.Round(lng, 7), Lat: geo.Round(lat, 7),
			Alt: geo.Round(p.Alt, 1), Acc: geo.Round(p.Acc, 1), Speed: geo.Round(p.Speed, 2), RecordedAt: time.UnixMilli(p.T),
		})
	}
	var accepted int64
	var trip model.Trip
	err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		if err := service.LockTrip(tx, t.ID); err != nil {
			return err
		}
		if len(rows) > 0 {
			res := tx.Clauses(clause.OnConflict{DoNothing: true}).CreateInBatches(&rows, 500)
			if res.Error != nil {
				return res.Error
			}
			accepted = res.RowsAffected
		}
		if accepted > 0 {
			if err := startTripIfPlanning(tx, t); err != nil {
				return err
			}
			if err := h.svc.RecomputeTrack(tx, t.ID); err != nil {
				return err
			}
		}
		return tx.Select("track_point_count", "track_distance_km").First(&trip, t.ID).Error
	})
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{"accepted": accepted, "total_points": trip.TrackPointCount, "distance_km": geo.Round(trip.TrackDistanceKm, 2)})
	return nil
}

func (h *Handler) getTrack(c *gin.Context) error {
	t, _, err := h.tripForView(c)
	if err != nil {
		return err
	}
	maxPts := 2000
	if v, err := strconv.Atoi(c.Query("max")); err == nil {
		maxPts = v
	}
	if maxPts < 10 {
		maxPts = 10
	}
	if maxPts > 20000 {
		maxPts = 20000
	}
	type row struct {
		UserID     int64
		Segment    int
		Lng, Lat   float64
		Alt        float64
		RecordedAt time.Time
	}
	var rows []row
	if err := h.db.WithContext(c.Request.Context()).Model(&model.TrackPoint{}).
		Select("user_id", "segment", "lng", "lat", "alt", "recorded_at").
		Where("trip_id = ?", t.ID).Order("user_id, segment, recorded_at").Scan(&rows).Error; err != nil {
		return err
	}
	// Group into segments.
	var groups [][]row
	for i, r := range rows {
		if i == 0 || r.UserID != rows[i-1].UserID || r.Segment != rows[i-1].Segment {
			groups = append(groups, nil)
		}
		groups[len(groups)-1] = append(groups[len(groups)-1], r)
	}
	pts := make([][]geo.Point, len(groups))
	for i, g := range groups {
		pts[i] = make([]geo.Point, len(g))
		for j, r := range g {
			pts[i][j] = geo.Point{Lng: r.Lng, Lat: r.Lat}
		}
	}
	// Increase the tolerance until the simplified track fits in maxPts.
	keep := make([][]int, len(groups))
	for tol := 0.0; ; {
		total := 0
		for i := range groups {
			keep[i] = geo.SimplifyIndices(pts[i], tol)
			total += len(keep[i])
		}
		if total <= maxPts || tol > 50000 {
			break
		}
		if tol == 0 {
			tol = 2
		} else {
			tol *= 2
		}
	}
	segments := make([][][4]float64, 0, len(groups))
	var started, ended *time.Time
	for i, g := range groups {
		seg := make([][4]float64, 0, len(keep[i]))
		for _, j := range keep[i] {
			r := g[j]
			seg = append(seg, [4]float64{geo.Round(r.Lng, 6), geo.Round(r.Lat, 6), geo.Round(r.Alt, 1), float64(r.RecordedAt.UnixMilli())})
		}
		segments = append(segments, seg)
		first, last := g[0].RecordedAt, g[len(g)-1].RecordedAt
		if started == nil || first.Before(*started) {
			started = &first
		}
		if ended == nil || last.After(*ended) {
			ended = &last
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"segments": segments, "point_count": len(rows), "distance_km": geo.Round(t.TrackDistanceKm, 2),
		"started_at": h.tsp(started), "ended_at": h.tsp(ended),
	})
	return nil
}

func (h *Handler) clearTrack(c *gin.Context) error {
	t, _, err := h.tripForEdit(c)
	if err != nil {
		return err
	}
	err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("trip_id = ?", t.ID).Delete(&model.TrackPoint{}).Error; err != nil {
			return err
		}
		return h.svc.RecomputeTrack(tx, t.ID)
	})
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{})
	return nil
}
