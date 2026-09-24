package service

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"triphub/internal/geo"
	"triphub/internal/media"
	"triphub/internal/model"
)

// RecomputeTrip refreshes a trip's denormalised statistics after waypoint,
// photo or track changes.
func (s *Service) RecomputeTrip(tx *gorm.DB, tripID int64) error {
	var t model.Trip
	if err := tx.Select("id", "start_date", "end_date", "track_point_count", "track_distance_km").First(&t, tripID).Error; err != nil {
		return err
	}
	var wps []model.Waypoint
	if err := tx.Where("trip_id = ?", tripID).Order("seq, id").Find(&wps).Error; err != nil {
		return err
	}
	planned := PlannedRoute(wps)
	actual := ActualRoute(wps)

	regionSrc := actual
	if len(actual) == 0 {
		regionSrc = planned
		if len(regionSrc) == 0 {
			regionSrc = wps
		}
	}
	cities, provinces := distinctRegions(regionSrc)

	var dist float64
	switch {
	case t.TrackPointCount > 0:
		dist = t.TrackDistanceKm
	case len(actual) > 0:
		dist = RouteKm(actual)
	default:
		dist = RouteKm(planned)
	}

	var photoCount int64
	if err := tx.Model(&model.Photo{}).Where("trip_id = ?", tripID).Count(&photoCount).Error; err != nil {
		return err
	}
	var firstPhoto model.Photo
	if err := tx.Where("trip_id = ?", tripID).Order("taken_at ASC NULLS LAST, id ASC").Limit(1).Find(&firstPhoto).Error; err != nil {
		return err
	}
	autoCover := ""
	if firstPhoto.ID != 0 {
		autoCover = media.URL(firstPhoto.Path)
	}

	return tx.Model(&model.Trip{}).Where("id = ?", tripID).Updates(map[string]any{
		"waypoint_count": len(wps),
		"planned_count":  len(planned),
		"visited_count":  len(actual),
		"photo_count":    photoCount,
		"cities":         jsonList(cities),
		"provinces":      jsonList(provinces),
		"distance_km":    dist,
		"days":           TripDays(t.StartDate, t.EndDate, wps, s.Loc),
		"auto_cover_url": autoCover,
	}).Error
}

// jsonList produces a value for a jsonb column in a map-based update.
func jsonList(v []string) any {
	if v == nil {
		v = []string{}
	}
	b, _ := json.Marshal(v)
	return gorm.Expr("?::jsonb", string(b))
}

// JSONList exposes jsonList for handlers updating jsonb columns.
func JSONList(v []string) any { return jsonList(v) }

// RecomputeTrack refreshes a trip's track point count and GPS distance
// (sum of great-circle steps within each user/segment), then the trip stats.
func (s *Service) RecomputeTrack(tx *gorm.DB, tripID int64) error {
	var row struct {
		N    int64
		Dist float64
	}
	err := tx.Raw(`
SELECT COUNT(*) AS n, COALESCE(SUM(d), 0) AS dist FROM (
  SELECT CASE WHEN plng IS NULL THEN 0 ELSE
    2 * 6371008.8 * asin(least(1, sqrt(
      power(sin(radians(lat - plat) / 2), 2) +
      cos(radians(plat)) * cos(radians(lat)) * power(sin(radians(lng - plng) / 2), 2)))) END AS d
  FROM (
    SELECT lng, lat,
      lag(lng) OVER w AS plng, lag(lat) OVER w AS plat
    FROM track_points WHERE trip_id = ?
    WINDOW w AS (PARTITION BY user_id, segment ORDER BY recorded_at)
  ) s
) x`, tripID).Scan(&row).Error
	if err != nil {
		return err
	}
	if err := tx.Model(&model.Trip{}).Where("id = ?", tripID).UpdateColumns(map[string]any{
		"track_point_count": row.N,
		"track_distance_km": geo.Round(row.Dist/1000, 2),
	}).Error; err != nil {
		return err
	}
	return s.RecomputeTrip(tx, tripID)
}

// RecomputePlaces refreshes aggregate statistics of places, counting only
// visited waypoints in public, normal trips.
func (s *Service) RecomputePlaces(tx *gorm.DB, ids []int64) error {
	ids = uniqueIDs(ids)
	if len(ids) == 0 {
		return nil
	}
	return tx.Exec(`
UPDATE places p SET
  checkin_count   = COALESCE(a.cnt, 0),
  rating_avg      = COALESCE(a.ravg, 0),
  rating_count    = COALESCE(a.rcnt, 0),
  recommend_count = COALESCE(a.rec, 0),
  neutral_count   = COALESCE(a.neu, 0),
  avoid_count     = COALESCE(a.avo, 0),
  avg_cost        = COALESCE(a.cost, 0),
  comment_count   = (SELECT COUNT(*) FROM comments c WHERE c.place_id = p.id AND NOT c.deleted),
  cover_url       = COALESCE((
      SELECT '/uploads/' || ph.path FROM photos ph
      JOIN waypoints w ON w.id = ph.waypoint_id
      JOIN trips t ON t.id = w.trip_id
      WHERE w.place_id = p.id AND w.status = 'visited' AND t.visibility = 'public' AND t.status = 'normal'
      ORDER BY ph.id DESC LIMIT 1), ''),
  updated_at      = now()
FROM (
  SELECT pl.id, agg.* FROM places pl
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS cnt,
      ROUND(AVG(w.rating) FILTER (WHERE w.rating > 0)::numeric, 1) AS ravg,
      COUNT(*) FILTER (WHERE w.rating > 0) AS rcnt,
      COUNT(*) FILTER (WHERE w.verdict = 'recommend') AS rec,
      COUNT(*) FILTER (WHERE w.verdict = 'neutral') AS neu,
      COUNT(*) FILTER (WHERE w.verdict = 'avoid') AS avo,
      ROUND(AVG(w.cost) FILTER (WHERE w.cost > 0)::numeric, 0) AS cost
    FROM waypoints w JOIN trips t ON t.id = w.trip_id
    WHERE w.place_id = pl.id AND w.status = 'visited' AND t.visibility = 'public' AND t.status = 'normal'
  ) agg ON true
  WHERE pl.id IN ?
) a
WHERE p.id = a.id`, ids).Error
}

// TripPlaceIDs returns the place IDs referenced by a trip's waypoints.
func TripPlaceIDs(tx *gorm.DB, tripID int64) ([]int64, error) {
	var ids []int64
	err := tx.Model(&model.Waypoint{}).Where("trip_id = ? AND place_id IS NOT NULL", tripID).Distinct().Pluck("place_id", &ids).Error
	return ids, err
}

func uniqueIDs(ids []int64) []int64 {
	seen := map[int64]bool{}
	out := ids[:0:0]
	for _, id := range ids {
		if id != 0 && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

// PlaceIDs collects non-nil place IDs.
func PlaceIDs(ptrs ...*int64) []int64 {
	var out []int64
	for _, p := range ptrs {
		if p != nil {
			out = append(out, *p)
		}
	}
	return out
}

// ResolvePlace finds or creates the Place a waypoint belongs to: by AMap ID,
// else by same name within 100 m; new places are only created for waypoints
// whose name was given by the user (or that carry an AMap ID).
func (s *Service) ResolvePlace(tx *gorm.DB, wp *model.Waypoint, userNamed bool) (*int64, error) {
	if wp.AmapID != "" {
		var p model.Place
		if err := tx.Where("amap_id = ?", wp.AmapID).Limit(1).Find(&p).Error; err != nil {
			return nil, err
		}
		if p.ID == 0 {
			p = placeFromWaypoint(wp)
			err := tx.Clauses(clause.OnConflict{
				Columns:     []clause.Column{{Name: "amap_id"}},
				TargetWhere: clause.Where{Exprs: []clause.Expression{clause.Expr{SQL: "amap_id <> ''"}}},
				DoNothing:   true,
			}).Create(&p).Error
			if err != nil {
				return nil, err
			}
			if p.ID == 0 { // lost a race; read the winner
				if err := tx.Where("amap_id = ?", wp.AmapID).First(&p).Error; err != nil {
					return nil, err
				}
			}
		}
		return &p.ID, nil
	}
	name := strings.TrimSpace(wp.Name)
	if !userNamed || name == "" {
		return nil, nil
	}
	minLng, minLat, maxLng, maxLat := geo.BBoxAround(wp.Lng, wp.Lat, 100)
	var cands []model.Place
	if err := tx.Where("lower(name) = lower(?) AND lng BETWEEN ? AND ? AND lat BETWEEN ? AND ?", name, minLng, maxLng, minLat, maxLat).
		Limit(20).Find(&cands).Error; err != nil {
		return nil, err
	}
	best, bestD := int64(0), 100.0
	for _, c := range cands {
		if d := geo.Haversine(wp.Lng, wp.Lat, c.Lng, c.Lat); d <= bestD {
			best, bestD = c.ID, d
		}
	}
	if best != 0 {
		return &best, nil
	}
	p := placeFromWaypoint(wp)
	if err := tx.Create(&p).Error; err != nil {
		return nil, err
	}
	return &p.ID, nil
}

func placeFromWaypoint(wp *model.Waypoint) model.Place {
	return model.Place{
		AmapID: wp.AmapID, Name: strings.TrimSpace(wp.Name), Address: wp.Address,
		Province: wp.Province, City: wp.City, District: wp.District,
		Lng: wp.Lng, Lat: wp.Lat, Category: wp.Category,
	}
}

// GeoInfo is the result of locating a coordinate.
type GeoInfo struct {
	Province     string
	ProvinceCode string
	City         string
	CityCode     string
	District     string
	Street       string
	Address      string
	Found        bool
}

// Locate resolves province/city offline and, when detail is requested and an
// AMap key is configured, district/street/address via reverse geocoding.
func (s *Service) Locate(ctx context.Context, lng, lat float64, detail bool) GeoInfo {
	var info GeoInfo
	if loc, ok := s.Atlas.LookupGCJ(lng, lat); ok {
		info = GeoInfo{Province: loc.Province, ProvinceCode: loc.ProvinceCode, City: loc.City, CityCode: loc.CityCode, Found: true}
	}
	if detail && s.Amap.Enabled() {
		cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		if r, err := s.Amap.Regeo(cctx, lng, lat); err == nil {
			info.District, info.Street, info.Address = r.District, r.Township, r.FormattedAddress
			if !info.Found && r.Province != "" {
				info.Province, info.City = r.Province, r.City
				if len(r.Adcode) == 6 {
					info.ProvinceCode = geo.ProvinceCodeOf(r.Adcode)
				}
				info.Found = true
			}
		}
	}
	return info
}

// AutoName builds a waypoint name from location info, e.g. "西湖区·北山街道" or "杭州市".
func (g GeoInfo) AutoName() string {
	switch {
	case g.District != "" && g.Street != "":
		return g.District + "·" + g.Street
	case g.District != "":
		return g.District
	case g.City != "":
		return g.City
	case g.Province != "":
		return g.Province
	}
	return "未命名地点"
}

// InsertWaypoint inserts wp at position seq (nil = append), shifting later
// waypoints. The caller must hold the trip lock.
func InsertWaypoint(tx *gorm.DB, wp *model.Waypoint, seq *int) error {
	var count int64
	if err := tx.Model(&model.Waypoint{}).Where("trip_id = ?", wp.TripID).Count(&count).Error; err != nil {
		return err
	}
	pos := int(count)
	if seq != nil && *seq >= 0 && *seq < pos {
		pos = *seq
		if err := tx.Exec("UPDATE waypoints SET seq = seq + 1 WHERE trip_id = ? AND seq >= ?", wp.TripID, pos).Error; err != nil {
			return err
		}
	}
	wp.Seq = pos
	return tx.Create(wp).Error
}

// CompactSeq renumbers a trip's waypoints to 0..n-1 keeping their order.
func CompactSeq(tx *gorm.DB, tripID int64) error {
	return tx.Exec(`
UPDATE waypoints w SET seq = s.rn - 1
FROM (SELECT id, row_number() OVER (ORDER BY seq, id) AS rn FROM waypoints WHERE trip_id = ?) s
WHERE w.id = s.id AND w.seq <> s.rn - 1`, tripID).Error
}

// ChronoInsertSeq returns the seq at which a waypoint arriving at t should be
// inserted: right after the last waypoint that arrived no later than t, else
// before the first one that arrived later; nil (append) when no waypoint has
// an arrival time.
func ChronoInsertSeq(wps []model.Waypoint, t *time.Time) *int {
	if t == nil {
		return nil
	}
	after, before := -1, -1
	for _, w := range wps {
		if w.ArrivedAt == nil {
			continue
		}
		if !w.ArrivedAt.After(*t) {
			if w.Seq > after {
				after = w.Seq
			}
		} else if before == -1 || w.Seq < before {
			before = w.Seq
		}
	}
	switch {
	case after >= 0:
		p := after + 1
		return &p
	case before >= 0:
		return &before
	}
	return nil
}

// DeleteTrip removes a trip and everything that belongs to it, releasing
// storage quota and deleting files.
func (s *Service) DeleteTrip(ctx context.Context, tripID int64) error {
	var files []string
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var photos []model.Photo
		if err := tx.Where("trip_id = ?", tripID).Find(&photos).Error; err != nil {
			return err
		}
		usage := map[int64]int64{}
		for _, p := range photos {
			files = append(files, p.Path, p.ThumbPath)
			usage[p.UserID] += p.Size
		}
		for uid, size := range usage {
			if err := tx.Exec("UPDATE users SET storage_used = GREATEST(storage_used - ?, 0) WHERE id = ?", size, uid).Error; err != nil {
				return err
			}
		}
		placeIDs, err := TripPlaceIDs(tx, tripID)
		if err != nil {
			return err
		}
		stmts := []string{
			"DELETE FROM photos WHERE trip_id = ?",
			"DELETE FROM waypoints WHERE trip_id = ?",
			"DELETE FROM track_points WHERE trip_id = ?",
			"DELETE FROM comments WHERE trip_id = ?",
			"DELETE FROM likes WHERE trip_id = ?",
			"DELETE FROM favorites WHERE trip_id = ?",
			"DELETE FROM trip_members WHERE trip_id = ?",
			"DELETE FROM notifications WHERE trip_id = ?",
			"UPDATE trips SET forked_from_id = NULL WHERE forked_from_id = ?",
			"DELETE FROM trips WHERE id = ?",
		}
		for _, q := range stmts {
			if err := tx.Exec(q, tripID).Error; err != nil {
				return err
			}
		}
		return s.RecomputePlaces(tx, placeIDs)
	})
	if err != nil {
		return err
	}
	s.Media.Remove(files...)
	return nil
}
