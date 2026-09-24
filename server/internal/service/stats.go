package service

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"triphub/internal/amap"
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
	dist := tripDistanceKm(t.TrackPointCount > 0, t.TrackDistanceKm, planned, actual)

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

// tripDistanceKm is a trip's distance_km. A GPS track often covers only part
// of a trip (the web recorder only runs while the page is open), so it must
// never shrink the distance below the check-in route: the longer of the two
// is used. Before any check-in it is the track, without a track the planned
// route.
func tripDistanceKm(hasTrack bool, trackKm float64, planned, actual []model.Waypoint) float64 {
	switch {
	case len(actual) > 0:
		return max(trackKm, RouteKm(actual))
	case hasTrack:
		return trackKm
	}
	return RouteKm(planned)
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

// RecomputeTrack refreshes a trip's track point count and GPS distance, then
// the trip stats. GPS distance: each member's track is measured separately
// (great-circle steps within each of that user's segments, kept as
// model.TrackStat rows) and the longest is used, so members recording the
// same walk together are not counted twice.
func (s *Service) RecomputeTrack(tx *gorm.DB, tripID int64) error {
	if err := tx.Exec("DELETE FROM track_stats WHERE trip_id = ?", tripID).Error; err != nil {
		return err
	}
	err := tx.Exec(`
INSERT INTO track_stats (trip_id, user_id, distance_m)
SELECT ?, user_id, SUM(d) FROM (
  SELECT user_id, CASE WHEN plng IS NULL THEN 0 ELSE
    2 * 6371008.8 * asin(least(1, sqrt(
      power(sin(radians(lat - plat) / 2), 2) +
      cos(radians(plat)) * cos(radians(lat)) * power(sin(radians(lng - plng) / 2), 2)))) END AS d
  FROM (
    SELECT user_id, lng, lat,
      lag(lng) OVER w AS plng, lag(lat) OVER w AS plat
    FROM track_points WHERE trip_id = ?
    WINDOW w AS (PARTITION BY user_id, segment ORDER BY recorded_at)
  ) s
) x GROUP BY user_id`, tripID, tripID).Error
	if err != nil {
		return err
	}
	var row struct {
		N    int64
		Dist float64
	}
	if err := tx.Raw(`SELECT (SELECT COUNT(*) FROM track_points WHERE trip_id = ?) AS n,
  COALESCE((SELECT MAX(distance_m) FROM track_stats WHERE trip_id = ?), 0) AS dist`, tripID, tripID).Scan(&row).Error; err != nil {
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

// trackStepsSQL sums the great-circle steps (metres) between consecutive
// points of one user's track segment recorded within [from, to].
const trackStepsSQL = `
SELECT COALESCE(SUM(2 * 6371008.8 * asin(least(1, sqrt(
    power(sin(radians(lat - plat) / 2), 2) +
    cos(radians(plat)) * cos(radians(lat)) * power(sin(radians(lng - plng) / 2), 2))))), 0)
FROM (
  SELECT lng::float8 AS lng, lat::float8 AS lat,
    lag(lng::float8) OVER w AS plng, lag(lat::float8) OVER w AS plat
  FROM track_points
  WHERE trip_id = ? AND user_id = ? AND segment = ? AND recorded_at BETWEEN ? AND ?
  WINDOW w AS (ORDER BY recorded_at)
) s WHERE plng IS NOT NULL`

// AppendTrack inserts GPS points of one user's track segment (points already
// stored are ignored) and updates the trip's point count and GPS distance
// incrementally: only the steps between the stored neighbours of the new
// points change, so the cost does not grow with the size of the track. The
// change is added to the user's own distance (model.TrackStat) and the trip
// keeps the longest member's, as RecomputeTrack does. The caller must hold
// the trip lock. It returns the number of points inserted.
func (s *Service) AppendTrack(tx *gorm.DB, tripID, userID int64, segment int, rows []model.TrackPoint) (int64, error) {
	if len(rows) == 0 {
		return 0, nil
	}
	from, to := rows[0].RecordedAt, rows[0].RecordedAt
	for _, r := range rows[1:] {
		if r.RecordedAt.Before(from) {
			from = r.RecordedAt
		}
		if r.RecordedAt.After(to) {
			to = r.RecordedAt
		}
	}
	// Widen [from, to] to the stored points right before and after the batch.
	var prev, next sql.NullTime
	if err := tx.Raw("SELECT max(recorded_at) FROM track_points WHERE trip_id = ? AND user_id = ? AND segment = ? AND recorded_at < ?",
		tripID, userID, segment, from).Scan(&prev).Error; err != nil {
		return 0, err
	}
	if err := tx.Raw("SELECT min(recorded_at) FROM track_points WHERE trip_id = ? AND user_id = ? AND segment = ? AND recorded_at > ?",
		tripID, userID, segment, to).Scan(&next).Error; err != nil {
		return 0, err
	}
	if prev.Valid {
		from = prev.Time
	}
	if next.Valid {
		to = next.Time
	}
	steps := func() (float64, error) {
		var m float64
		err := tx.Raw(trackStepsSQL, tripID, userID, segment, from, to).Scan(&m).Error
		return m, err
	}
	before, err := steps()
	if err != nil {
		return 0, err
	}
	res := tx.Clauses(clause.OnConflict{DoNothing: true}).CreateInBatches(&rows, 500)
	if res.Error != nil {
		return 0, res.Error
	}
	if res.RowsAffected == 0 {
		return 0, nil
	}
	// A trip whose points were stored before per-member distances were kept
	// has none of them yet: measure it once in full.
	var legacy bool
	if err := tx.Raw("SELECT track_point_count > 0 AND NOT EXISTS (SELECT 1 FROM track_stats WHERE trip_id = ?) FROM trips WHERE id = ?",
		tripID, tripID).Scan(&legacy).Error; err != nil {
		return 0, err
	}
	if legacy {
		return res.RowsAffected, s.RecomputeTrack(tx, tripID)
	}
	after, err := steps()
	if err != nil {
		return 0, err
	}
	// Increments are not rounded so rounding errors do not add up.
	if err := tx.Exec(`INSERT INTO track_stats (trip_id, user_id, distance_m) VALUES (?, ?, ?)
ON CONFLICT (trip_id, user_id) DO UPDATE SET distance_m = track_stats.distance_m + EXCLUDED.distance_m`,
		tripID, userID, after-before).Error; err != nil {
		return 0, err
	}
	var km float64
	if err := tx.Raw("SELECT COALESCE(MAX(distance_m), 0) / 1000 FROM track_stats WHERE trip_id = ?", tripID).Scan(&km).Error; err != nil {
		return 0, err
	}
	// distance_km as RecomputeTrip sets it (tripDistanceKm): only the visited
	// stops are needed, and they do not grow with the track.
	var visited []model.Waypoint
	if err := tx.Select("id", "seq", "status", "arrived_at", "lng", "lat").
		Where("trip_id = ? AND status = ?", tripID, model.WPVisited).Find(&visited).Error; err != nil {
		return 0, err
	}
	err = tx.Exec("UPDATE trips SET track_point_count = track_point_count + ?, track_distance_km = ?, distance_km = ? WHERE id = ?",
		res.RowsAffected, km, tripDistanceKm(true, km, nil, ActualRoute(visited)), tripID).Error
	return res.RowsAffected, err
}

// RecomputePlaces refreshes aggregate statistics of places, counting only
// visited waypoints in public, normal trips, and each person once with
// their latest non-empty verdict, rating and cost (by arrival time), so that
// "N 人打卡 / N 人踩雷" really counts people and a later visit replaces an
// earlier opinion.
func (s *Service) RecomputePlaces(tx *gorm.DB, ids []int64) error {
	ids = uniqueIDs(ids)
	if len(ids) == 0 {
		return nil
	}
	// Lock the rows (in id order) so the comment_count recount cannot
	// overwrite the count of a place comment committed meanwhile.
	if err := tx.Exec("SELECT id FROM places WHERE id IN ? ORDER BY id FOR UPDATE", ids).Error; err != nil {
		return err
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
      ROUND(AVG(u.rating)::numeric, 1) AS ravg,
      COUNT(u.rating) AS rcnt,
      COUNT(*) FILTER (WHERE u.verdict = 'recommend') AS rec,
      COUNT(*) FILTER (WHERE u.verdict = 'neutral') AS neu,
      COUNT(*) FILTER (WHERE u.verdict = 'avoid') AS avo,
      ROUND(AVG(u.cost)::numeric, 0) AS cost
    FROM (
      -- one row per person: the latest verdict / rating / cost they gave
      SELECT
        (array_agg(w.verdict ORDER BY COALESCE(w.arrived_at, w.created_at) DESC, w.id DESC) FILTER (WHERE w.verdict <> ''))[1] AS verdict,
        (array_agg(w.rating ORDER BY COALESCE(w.arrived_at, w.created_at) DESC, w.id DESC) FILTER (WHERE w.rating > 0))[1] AS rating,
        (array_agg(w.cost ORDER BY COALESCE(w.arrived_at, w.created_at) DESC, w.id DESC) FILTER (WHERE w.cost > 0))[1] AS cost
      FROM waypoints w JOIN trips t ON t.id = w.trip_id
      WHERE w.place_id = pl.id AND w.status = 'visited' AND t.visibility = 'public' AND t.status = 'normal'
      GROUP BY COALESCE(NULLIF(w.created_by_id, 0), t.owner_id)
    ) u
  ) agg ON true
  WHERE pl.id IN ?
) a
WHERE p.id = a.id`, ids).Error
}

// placeStatsVersion identifies how place statistics are counted (2: each
// person once, by their latest opinion); see BackfillPlaceStats.
const placeStatsVersion = "2"

// BackfillPlaceStats recomputes the statistics of every place once after an
// upgrade that changed how they are counted, so that counts stored by an
// older version are corrected. The version done is kept in the settings
// table (key place_stats_v).
func (s *Service) BackfillPlaceStats(ctx context.Context) error {
	db := s.DB.WithContext(ctx)
	var done model.Setting
	if err := db.Where("key = ?", "place_stats_v").Limit(1).Find(&done).Error; err != nil {
		return err
	}
	if done.Value == placeStatsVersion {
		return nil
	}
	var ids []int64
	if err := db.Model(&model.Place{}).Order("id").Pluck("id", &ids).Error; err != nil {
		return err
	}
	for len(ids) > 0 {
		chunk := ids[:min(len(ids), 1000)]
		if err := db.Transaction(func(tx *gorm.DB) error { return s.RecomputePlaces(tx, chunk) }); err != nil {
			return err
		}
		ids = ids[len(chunk):]
	}
	return db.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "key"}}, DoUpdates: clause.AssignmentColumns([]string{"value"})}).
		Create(&model.Setting{Key: "place_stats_v", Value: placeStatsVersion}).Error
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

// ResolvePlace finds or creates the Place a waypoint belongs to: by AMap ID
// (only a Place built from AMap's own POI data, within amapLinkMaxM of the
// waypoint), else by same name within 100 m; new places are only created for
// waypoints whose name was given by the user (or that carry a verified AMap
// ID). Name matching only joins places that are public (public check-ins or
// an AMap ID) or already used in a trip the actor is a member of, since a
// place's name, address and position come from the waypoint that created
// it, which may belong to a private trip.
func (s *Service) ResolvePlace(tx *gorm.DB, wp *model.Waypoint, userNamed bool, actorID int64) (*int64, error) {
	if wp.AmapID != "" {
		var p model.Place
		if err := tx.Where("amap_id = ?", wp.AmapID).Limit(1).Find(&p).Error; err != nil {
			return nil, err
		}
		if p.ID != 0 && geo.Haversine(wp.Lng, wp.Lat, p.Lng, p.Lat) <= amapLinkMaxM {
			return &p.ID, nil
		}
		// A shared AMap place is only created from AMap's own data (cached from
		// search results or by WarmPOI), never from the client's name and position.
		if poi, ok := s.Amap.CachedPOI(wp.AmapID); ok && p.ID == 0 && geo.Haversine(wp.Lng, wp.Lat, poi.Lng, poi.Lat) <= amapLinkMaxM {
			p = placeFromPOI(poi)
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
			return &p.ID, nil
		}
		// Unverified, unknown or far-away AMap ID: match by name like any other waypoint.
	}
	name := strings.TrimSpace(wp.Name)
	if !userNamed || name == "" {
		return nil, nil
	}
	minLng, minLat, maxLng, maxLat := geo.BBoxAround(wp.Lng, wp.Lat, 100)
	own := tx.Model(&model.Waypoint{}).Select("place_id").Where("place_id IS NOT NULL AND trip_id IN (?)", MemberTripIDs(tx, actorID))
	var cands []model.Place
	if err := tx.Where("lower(name) = lower(?) AND lng BETWEEN ? AND ? AND lat BETWEEN ? AND ?", name, minLng, maxLng, minLat, maxLat).
		Where("(checkin_count > 0 OR amap_id <> '' OR id IN (?))", own).
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

// amapLinkMaxM is how far (metres) a waypoint may be from an AMap POI and
// still be linked to its Place by amap_id; generous because large scenic
// areas have a single POI point.
const amapLinkMaxM = 5000

// placeFromWaypoint builds a Place from a user's waypoint. It never carries
// the waypoint's amap_id: places with an AMap ID come from AMap's data only.
func placeFromWaypoint(wp *model.Waypoint) model.Place {
	return model.Place{
		Name: strings.TrimSpace(wp.Name), Address: wp.Address,
		Province: wp.Province, City: wp.City, District: wp.District,
		Lng: wp.Lng, Lat: wp.Lat, Category: wp.Category,
	}
}

// placeFromPOI builds a Place from AMap's POI data (strings cut to the column
// sizes; Truncate appends "…", hence size-1).
func placeFromPOI(p amap.POI) model.Place {
	return model.Place{
		AmapID: p.ID, Name: Truncate(strings.TrimSpace(p.Name), 199), Address: Truncate(p.Address, 299),
		Province: Truncate(p.Province, 63), City: Truncate(p.City, 63), District: Truncate(p.District, 63),
		Lng: p.Lng, Lat: p.Lat, Category: p.Category, Tel: Truncate(p.Tel, 99),
	}
}

// WarmPOI caches AMap's own data for an amap_id that has no Place yet, so
// that ResolvePlace (which runs inside a transaction and never uses the
// network) can create the Place from it. Errors are ignored: an unverified
// ID is then matched by name.
func (s *Service) WarmPOI(ctx context.Context, id string) {
	if id == "" || !s.Amap.Enabled() {
		return
	}
	if _, ok := s.Amap.CachedPOI(id); ok {
		return
	}
	var n int64
	if err := s.DB.WithContext(ctx).Model(&model.Place{}).Where("amap_id = ?", id).Count(&n).Error; err != nil || n > 0 {
		return
	}
	cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	_, _ = s.Amap.Detail(cctx, id)
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

// RecomputeForkCount sets a trip's fork_count to the number of distinct
// users other than its owner who currently hold a fork of it (exact, like
// like_count / fav_count). The row is locked first so the count sees forks
// committed concurrently.
func RecomputeForkCount(tx *gorm.DB, tripID int64) error {
	if err := LockTrip(tx, tripID); err != nil {
		return err
	}
	return tx.Exec(`UPDATE trips t SET fork_count = (
  SELECT COUNT(DISTINCT f.owner_id) FROM trips f
  WHERE f.forked_from_id = t.id AND f.owner_id <> t.owner_id)
WHERE t.id = ?`, tripID).Error
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
		var self model.Trip
		if err := tx.Select("id", "forked_from_id").Limit(1).Find(&self, tripID).Error; err != nil {
			return err
		}
		stmts := []string{
			"DELETE FROM photos WHERE trip_id = ?",
			"DELETE FROM waypoints WHERE trip_id = ?",
			"DELETE FROM track_points WHERE trip_id = ?",
			"DELETE FROM track_stats WHERE trip_id = ?",
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
		if self.ForkedFromID != nil { // one fork fewer
			if err := RecomputeForkCount(tx, *self.ForkedFromID); err != nil {
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
