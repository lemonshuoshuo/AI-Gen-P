package handler

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
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

const (
	maxTrackPointsPerRequest = 1000
	maxTrackPointsPerTrip    = 1_000_000
	maxImportPoints          = 50000
	// maxTrackSegment bounds the client-chosen segment id (e.g. the Unix
	// seconds when recording started). The column is bigint; the cap is the
	// largest integer a JavaScript client can represent exactly.
	maxTrackSegment = 1<<53 - 1
)

// trackTiers are the point budgets of GET /trips/:id/track; ?max is rounded
// down to one of them so that renders can be cached.
var trackTiers = []int{10, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000}

func errTrackFull() error {
	return errTooLarge(fmt.Sprintf("这次旅程的轨迹点已达上限（%d 个），请新建旅程继续记录", maxTrackPointsPerTrip))
}

// trackPointCount reads the stored point count of a (locked) trip.
func trackPointCount(tx *gorm.DB, tripID int64) (int64, error) {
	var n int64
	err := tx.Raw("SELECT track_point_count FROM trips WHERE id = ?", tripID).Scan(&n).Error
	return n, err
}

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
	if req.Segment < 0 || int64(req.Segment) > maxTrackSegment {
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
			cur, err := trackPointCount(tx, t.ID)
			if err != nil {
				return err
			}
			if cur+int64(len(rows)) > maxTrackPointsPerTrip {
				return errTrackFull()
			}
			if accepted, err = h.svc.AppendTrack(tx, t.ID, uid, req.Segment, rows); err != nil {
				return err
			}
		}
		if accepted > 0 {
			if err := startTripIfPlanning(tx, t); err != nil {
				return err
			}
		}
		return tx.Select("track_point_count", "track_distance_km").First(&trip, t.ID).Error
	})
	if err != nil {
		return err
	}
	if accepted > 0 {
		h.trackCache.dropTrip(t.ID)
	}
	c.JSON(http.StatusOK, gin.H{"accepted": accepted, "total_points": trip.TrackPointCount, "distance_km": geo.Round(trip.TrackDistanceKm, 2)})
	return nil
}

// trackPayload is the GET /trips/:id/track response.
type trackPayload struct {
	Segments   [][][4]float64 `json:"segments"`
	PointCount int            `json:"point_count"`
	DistanceKm float64        `json:"distance_km"`
	StartedAt  *string        `json:"started_at"`
	EndedAt    *string        `json:"ended_at"`
}

func (h *Handler) getTrack(c *gin.Context) error {
	since := time.Now() // before the trip is loaded, see trackCache.put
	t, a, err := h.tripForView(c)
	if err != nil {
		return err
	}
	if t.TrackPointCount == 0 || a.HideLive(t) {
		c.JSON(http.StatusOK, trackPayload{Segments: [][][4]float64{}})
		return nil
	}
	maxPts := 2000
	if v, err := strconv.Atoi(c.Query("max")); err == nil {
		maxPts = v
	}
	budget := trackTiers[0]
	for _, n := range trackTiers {
		if n <= maxPts {
			budget = n
		}
	}
	key := trackKey{trip: t.ID, points: t.TrackPointCount, budget: budget}
	b, ok := h.trackCache.get(key)
	if !ok {
		if b, err = h.renderTrack(c.Request.Context(), t, budget); err != nil {
			return err
		}
		h.trackCache.put(key, b, since)
	}
	c.Data(http.StatusOK, "application/json; charset=utf-8", b)
	return nil
}

// renderTrack loads a trip's track and simplifies it to at most budget
// points. Tracks much larger than the budget are first thinned in SQL
// (every n-th point, keeping the first and last point of each segment), so
// memory and CPU stay bounded however long the track is.
func (h *Handler) renderTrack(ctx context.Context, t *model.Trip, budget int) ([]byte, error) {
	const cols = "user_id, segment, lng::float8, lat::float8, alt::float8, floor(extract(epoch from recorded_at) * 1000)::int8"
	db := h.db.WithContext(ctx)
	var rows *sql.Rows
	var err error
	if step := (t.TrackPointCount + 4*budget - 1) / (4 * budget); step > 1 {
		rows, err = db.Raw(`SELECT `+cols+` FROM (
  SELECT user_id, segment, lng, lat, alt, recorded_at,
    row_number() OVER w AS rn, lead(recorded_at) OVER w AS nx
  FROM track_points WHERE trip_id = ?
  WINDOW w AS (PARTITION BY user_id, segment ORDER BY recorded_at)
) s WHERE (rn - 1) % ? = 0 OR nx IS NULL
ORDER BY user_id, segment, recorded_at`, t.ID, step).Rows()
	} else {
		rows, err = db.Raw(`SELECT `+cols+` FROM track_points WHERE trip_id = ? ORDER BY user_id, segment, recorded_at`, t.ID).Rows()
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type point struct {
		lng, lat, alt float64
		t             int64 // Unix ms
	}
	// Group into segments.
	var groups [][]point
	var lastUser int64
	var lastSeg int
	for rows.Next() {
		var uid int64
		var seg int
		var p point
		if err := rows.Scan(&uid, &seg, &p.lng, &p.lat, &p.alt, &p.t); err != nil {
			return nil, err
		}
		if len(groups) == 0 || uid != lastUser || seg != lastSeg {
			groups = append(groups, nil)
			lastUser, lastSeg = uid, seg
		}
		groups[len(groups)-1] = append(groups[len(groups)-1], p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	pts := make([][]geo.Point, len(groups))
	for i, g := range groups {
		pts[i] = make([]geo.Point, len(g))
		for j, p := range g {
			pts[i][j] = geo.Point{Lng: p.lng, Lat: p.lat}
		}
	}
	// Increase the tolerance until the simplified track fits in the budget.
	keep := make([][]int, len(groups))
	for tol := 0.0; ; {
		total := 0
		for i := range groups {
			keep[i] = geo.SimplifyIndices(pts[i], tol)
			total += len(keep[i])
		}
		if total <= budget || tol > 50000 {
			break
		}
		if tol == 0 {
			tol = 2
		} else {
			tol *= 2
		}
	}
	out := trackPayload{Segments: make([][][4]float64, 0, len(groups)), PointCount: t.TrackPointCount,
		DistanceKm: geo.Round(t.TrackDistanceKm, 2)}
	var started, ended int64
	for i, g := range groups {
		seg := make([][4]float64, 0, len(keep[i]))
		for _, j := range keep[i] {
			p := g[j]
			seg = append(seg, [4]float64{geo.Round(p.lng, 6), geo.Round(p.lat, 6), geo.Round(p.alt, 1), float64(p.t)})
		}
		out.Segments = append(out.Segments, seg)
		if first := g[0].t; i == 0 || first < started {
			started = first
		}
		if last := g[len(g)-1].t; i == 0 || last > ended {
			ended = last
		}
	}
	if len(groups) > 0 {
		s, e := time.UnixMilli(started), time.UnixMilli(ended)
		out.StartedAt, out.EndedAt = h.tsp(&s), h.tsp(&e)
	}
	return json.Marshal(out)
}

func (h *Handler) clearTrack(c *gin.Context) error {
	t, _, err := h.tripForEdit(c)
	if err != nil {
		return err
	}
	err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		// Serialise with appends, which update the counters incrementally.
		if err := service.LockTrip(tx, t.ID); err != nil {
			return err
		}
		if err := tx.Where("trip_id = ?", t.ID).Delete(&model.TrackPoint{}).Error; err != nil {
			return err
		}
		return h.svc.RecomputeTrack(tx, t.ID)
	})
	if err != nil {
		return err
	}
	h.trackCache.dropTrip(t.ID)
	c.JSON(http.StatusOK, gin.H{})
	return nil
}

// importTrack adds the track segments of a GPX file (e.g. recorded with
// 两步路 / 六只脚 or a sports watch) to the current user's track. Each
// segment keeps its own segment id (Unix seconds of its first point), so
// importing the same file again adds nothing.
func (h *Handler) importTrack(c *gin.Context) error {
	t, _, err := h.tripForEdit(c)
	if err != nil {
		return err
	}
	fh, err := c.FormFile("file")
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return errTooLarge(fmt.Sprintf("文件不能超过 %d MB", h.cfg.MaxUploadMB))
		}
		return errBad("请选择要导入的 GPX 文件（字段 file）")
	}
	if fh.Size > h.cfg.MaxUploadBytes() {
		return errTooLarge(fmt.Sprintf("文件不能超过 %d MB", h.cfg.MaxUploadMB))
	}
	ct, err := coordType(c.PostForm("coord_type"), "wgs84")
	if err != nil {
		return err
	}
	f, err := fh.Open()
	if err != nil {
		return err
	}
	defer f.Close()
	segs, err := geo.ParseGPX(f, maxImportPoints)
	if errors.Is(err, geo.ErrTooManyPoints) {
		return errBad(fmt.Sprintf("轨迹点太多（最多 %d 个）", maxImportPoints))
	}
	if err != nil {
		return errBad("无法解析 GPX 文件，请确认文件完整且为 GPX 格式")
	}
	uid := currentUserID(c)
	minT := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	maxT := time.Now().Add(24 * time.Hour)
	var rows []model.TrackPoint
	used := map[int]bool{}
	for _, seg := range segs {
		id := -1
		for _, p := range seg {
			if p.Time.Before(minT) || p.Time.After(maxT) {
				continue
			}
			if id < 0 {
				id = int(p.Time.Unix())
				for used[id] { // two segments starting in the same second
					id++
				}
				used[id] = true
			}
			lng, lat := geo.ToGCJ02(p.Lng, p.Lat, ct)
			rows = append(rows, model.TrackPoint{TripID: t.ID, UserID: uid, Segment: id, Lng: geo.Round(lng, 7),
				Lat: geo.Round(lat, 7), Alt: geo.Round(p.Ele, 1), RecordedAt: p.Time})
		}
	}
	if len(rows) == 0 {
		return errBad("文件里没有带时间的轨迹点")
	}
	var accepted int64
	var trip model.Trip
	err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		if err := service.LockTrip(tx, t.ID); err != nil {
			return err
		}
		cur, err := trackPointCount(tx, t.ID)
		if err != nil {
			return err
		}
		if cur+int64(len(rows)) > maxTrackPointsPerTrip {
			return errTrackFull()
		}
		res := tx.Clauses(clause.OnConflict{DoNothing: true}).CreateInBatches(&rows, 500)
		if res.Error != nil {
			return res.Error
		}
		if accepted = res.RowsAffected; accepted > 0 {
			if err := h.svc.RecomputeTrack(tx, t.ID); err != nil {
				return err
			}
		}
		return tx.Select("track_point_count", "track_distance_km").First(&trip, t.ID).Error
	})
	if err != nil {
		return err
	}
	if accepted > 0 {
		h.trackCache.dropTrip(t.ID)
	}
	c.JSON(http.StatusOK, gin.H{"accepted": accepted, "total_points": trip.TrackPointCount,
		"distance_km": geo.Round(trip.TrackDistanceKm, 2), "segments": len(used)})
	return nil
}
