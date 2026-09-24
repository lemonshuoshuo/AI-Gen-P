package handler

import (
	"math"
	"net/http"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"triphub/internal/geo"
	"triphub/internal/model"
)

func (h *Handler) listPlaces(c *gin.Context) error {
	db := h.db.WithContext(c.Request.Context())
	q := db.Model(&model.Place{}).Where("checkin_count > 0")
	if kw := strings.TrimSpace(c.Query("q")); kw != "" {
		like := escapeLike(kw)
		q = q.Where("(name ILIKE ? OR address ILIKE ? OR district ILIKE ?)", like, like, like)
	}
	if city := strings.TrimSpace(c.Query("city")); city != "" {
		q = q.Where("(city ILIKE ? OR province ILIKE ?)", escapeLike(city), escapeLike(city))
	}
	if cat := c.Query("category"); cat != "" {
		if !slices.Contains(model.Categories, cat) {
			return errBad("category 无效")
		}
		q = q.Where("category = ?", cat)
	}
	order := "checkin_count DESC, comment_count DESC, id DESC"
	switch c.DefaultQuery("sort", "hot") {
	case "hot", "":
	case "rating":
		q = q.Where("rating_count > 0")
		order = "rating_avg DESC, rating_count DESC, checkin_count DESC, id DESC"
	case "avoid":
		q = q.Where("avoid_count > 0")
		order = "avoid_count DESC, (avoid_count::float / GREATEST(checkin_count, 1)) DESC, id DESC"
	default:
		return errBad("sort 参数无效")
	}
	p := pageParams(c)
	var places []model.Place
	total, err := paginate(q, p, order, &places)
	if err != nil {
		return err
	}
	items := make([]PlaceDTO, len(places))
	for i := range places {
		items[i] = h.placeDTO(&places[i])
	}
	c.JSON(http.StatusOK, newPage(items, total, p))
	return nil
}

func (h *Handler) nearbyPlaces(c *gin.Context) error {
	pos, err := positionFromQuery(c)
	if err != nil {
		return err
	}
	if pos == nil {
		return errBad("请提供 lng / lat")
	}
	radius := 2000.0
	if v, ok := queryFloat(c, "radius"); ok {
		radius = math.Max(50, math.Min(v, 50000))
	}
	limit := 30
	if v, err := strconv.Atoi(c.Query("limit")); err == nil && v > 0 {
		limit = min(v, 100)
	}
	minLng, minLat, maxLng, maxLat := geo.BBoxAround(pos.Lng, pos.Lat, radius)
	var places []model.Place
	q := h.db.WithContext(c.Request.Context()).Where("checkin_count > 0 AND lng BETWEEN ? AND ? AND lat BETWEEN ? AND ?", minLng, maxLng, minLat, maxLat)
	if cat := c.Query("category"); cat != "" {
		q = q.Where("category = ?", cat)
	}
	if err := q.Order("checkin_count DESC").Limit(3000).Find(&places).Error; err != nil {
		return err
	}
	type hit struct {
		p *model.Place
		d float64
	}
	hits := make([]hit, 0, len(places))
	for i := range places {
		if d := geo.Haversine(pos.Lng, pos.Lat, places[i].Lng, places[i].Lat); d <= radius {
			hits = append(hits, hit{&places[i], d})
		}
	}
	sort.Slice(hits, func(i, j int) bool { return hits[i].d < hits[j].d })
	if len(hits) > limit {
		hits = hits[:limit]
	}
	out := make([]PlaceDTO, len(hits))
	for i, ht := range hits {
		out[i] = h.placeDTO(ht.p)
		d := int(math.Round(ht.d))
		out[i].DistanceM = &d
	}
	c.JSON(http.StatusOK, out)
	return nil
}

func (h *Handler) getPlace(c *gin.Context) error {
	p, err := h.loadPlace(c)
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, h.placeDTO(p))
	return nil
}

func (h *Handler) placeReviews(c *gin.Context) error {
	p, err := h.loadPlace(c)
	if err != nil {
		return err
	}
	ctx := c.Request.Context()
	db := h.db.WithContext(ctx)
	q := db.Model(&model.Waypoint{}).
		Joins("JOIN trips t ON t.id = waypoints.trip_id AND t.visibility = ? AND t.status = ?", model.VisPublic, model.TripNormal).
		Where("waypoints.place_id = ? AND waypoints.status = ?", p.ID, model.WPVisited)
	if v := c.Query("verdict"); v != "" {
		if v != model.VerdictRecommend && v != model.VerdictNeutral && v != model.VerdictAvoid {
			return errBad("verdict 参数无效")
		}
		q = q.Where("waypoints.verdict = ?", v)
	}
	pg := pageParams(c)
	var wps []model.Waypoint
	total, err := paginate(q, pg, "waypoints.arrived_at DESC NULLS LAST, waypoints.id DESC", &wps)
	if err != nil {
		return err
	}
	type review struct {
		Waypoint WaypointDTO `json:"waypoint"`
		Photos   []PhotoDTO  `json:"photos"`
		Trip     TripRef     `json:"trip"`
		Author   *UserBrief  `json:"author"`
	}
	items := make([]review, 0, len(wps))
	if len(wps) > 0 {
		var wpIDs, tripIDs []int64
		for _, w := range wps {
			wpIDs = append(wpIDs, w.ID)
			tripIDs = append(tripIDs, w.TripID)
		}
		var trips []model.Trip
		if err := db.Select("id", "title", "owner_id").Where("id IN ?", uniq(tripIDs)).Find(&trips).Error; err != nil {
			return err
		}
		tripByID := map[int64]*model.Trip{}
		var userIDs []int64
		for i := range trips {
			tripByID[trips[i].ID] = &trips[i]
			userIDs = append(userIDs, trips[i].OwnerID)
		}
		for _, w := range wps {
			userIDs = append(userIDs, w.CreatedByID)
		}
		users, err := h.loadUsers(ctx, userIDs)
		if err != nil {
			return err
		}
		var photos []model.Photo
		if err := db.Where("waypoint_id IN ?", wpIDs).Order("taken_at ASC NULLS LAST, id").Find(&photos).Error; err != nil {
			return err
		}
		byWP := map[int64][]model.Photo{}
		for _, ph := range photos {
			if len(byWP[*ph.WaypointID]) < 9 {
				byWP[*ph.WaypointID] = append(byWP[*ph.WaypointID], ph)
			}
		}
		for i := range wps {
			w := &wps[i]
			t := tripByID[w.TripID]
			if t == nil {
				continue
			}
			author := users[w.CreatedByID]
			if author == nil {
				author = users[t.OwnerID]
			}
			items = append(items, review{Waypoint: h.waypointDTO(w), Photos: h.photoDTOs(byWP[w.ID]),
				Trip: TripRef{ID: t.ID, Title: t.Title}, Author: userBrief(author)})
		}
	}
	c.JSON(http.StatusOK, newPage(items, total, pg))
	return nil
}
