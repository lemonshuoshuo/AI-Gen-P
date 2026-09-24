package handler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"triphub/internal/ai"
	"triphub/internal/geo"
	"triphub/internal/model"
	"triphub/internal/service"
)

const (
	checkinMatchRadius = 200.0
	// checkinTieMeters: planned stops within this distance of the closest one
	// count as the same spot (e.g. the hotel at the start and end of a day).
	checkinTieMeters = 20.0
	// A check-in this close to, and this soon after, an existing visit
	// repeats that visit (a double tap, a retried request or a travel partner).
	checkinDupRadius = 50.0
	checkinDupWindow = 5 * time.Minute
)

// startTripIfPlanning moves a planning trip to ongoing.
func startTripIfPlanning(tx *gorm.DB, t *model.Trip) error {
	if t.Phase != model.PhasePlanning {
		return nil
	}
	t.Phase = model.PhaseOngoing
	return tx.Model(&model.Trip{}).Where("id = ?", t.ID).Update("phase", model.PhaseOngoing).Error
}

// nearestTodo returns the closest planned todo waypoint within radius metres;
// candidates within checkinTieMeters of the closest distance count as the
// same spot and the lowest seq wins. wps must be ordered by seq, id.
func nearestTodo(wps []model.Waypoint, lng, lat, radius float64) *model.Waypoint {
	type cand struct {
		w *model.Waypoint
		d float64
	}
	var cs []cand
	minD := radius
	for i := range wps {
		w := &wps[i]
		if !w.Planned || w.Status != model.WPTodo {
			continue
		}
		if d := geo.Haversine(lng, lat, w.Lng, w.Lat); d <= radius {
			cs = append(cs, cand{w, d})
			minD = min(minD, d)
		}
	}
	var best *model.Waypoint
	for _, c := range cs {
		if c.d <= minD+checkinTieMeters && (best == nil || c.w.Seq < best.Seq) {
			best = c.w
		}
	}
	return best
}

// checkinTarget picks the waypoint a location check-in at (lng, lat) and
// time at refers to. It returns (w, true) when the check-in repeats a visit:
// w was visited within checkinDupWindow and lies within checkinDupRadius,
// with no todo planned stop closer; a given amap_id or name must match too.
// Otherwise it returns the planned stop to mark visited (nil: none).
func checkinTarget(wps []model.Waypoint, lng, lat float64, at time.Time, name, amapID string) (*model.Waypoint, bool) {
	todo := nearestTodo(wps, lng, lat, checkinMatchRadius)
	var recent *model.Waypoint
	bestD := checkinDupRadius
	for i := range wps {
		w := &wps[i]
		if w.Status != model.WPVisited || w.ArrivedAt == nil {
			continue
		}
		if dt := at.Sub(*w.ArrivedAt); dt > checkinDupWindow || dt < -checkinDupWindow {
			continue
		}
		if amapID != "" && w.AmapID != amapID {
			continue
		}
		if amapID == "" && name != "" && !strings.EqualFold(strings.TrimSpace(w.Name), name) {
			continue
		}
		if d := geo.Haversine(lng, lat, w.Lng, w.Lat); d <= bestD {
			recent, bestD = w, d
		}
	}
	if recent != nil && (todo == nil || bestD <= geo.Haversine(lng, lat, todo.Lng, todo.Lat)) {
		return recent, true
	}
	return todo, false
}

// markVisited sets a waypoint visited at the given time (keeping an existing arrival time).
func markVisited(tx *gorm.DB, wp *model.Waypoint, at time.Time, override bool) error {
	if wp.Status == model.WPVisited && wp.ArrivedAt != nil && !override {
		return nil
	}
	wp.Status = model.WPVisited
	wp.ArrivedAt = &at
	return tx.Model(wp).Updates(map[string]any{"status": wp.Status, "arrived_at": at}).Error
}

func (h *Handler) tripCheckin(c *gin.Context) error {
	t, _, err := h.tripForEdit(c)
	if err != nil {
		return err
	}
	var req struct {
		Lng        *float64 `json:"lng"`
		Lat        *float64 `json:"lat"`
		CoordType  string   `json:"coord_type"`
		Name       string   `json:"name"`
		Address    string   `json:"address"`
		AmapID     string   `json:"amap_id"`
		Category   string   `json:"category"`
		Note       string   `json:"note"`
		WaypointID *int64   `json:"waypoint_id"`
		ArrivedAt  string   `json:"arrived_at"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	at, override := time.Now(), false
	if req.ArrivedAt != "" {
		p, err := parseTime(req.ArrivedAt, "arrived_at", h.loc)
		if err != nil {
			return err
		}
		at, override = *p, true
	}
	ctx := c.Request.Context()
	db := h.db.WithContext(ctx)
	var result model.Waypoint
	matched, duplicate := false, false

	if req.WaypointID != nil && *req.WaypointID != 0 {
		err = db.Transaction(func(tx *gorm.DB) error {
			if err := service.LockTrip(tx, t.ID); err != nil {
				return err
			}
			if err := tx.Where("id = ? AND trip_id = ?", *req.WaypointID, t.ID).Limit(1).Find(&result).Error; err != nil {
				return err
			}
			if result.ID == 0 {
				return errNotFound("打卡点不存在")
			}
			matched = result.Planned
			duplicate = result.Status == model.WPVisited && result.ArrivedAt != nil
			// An already-visited stop keeps its arrival time unless arrived_at is given.
			if err := markVisited(tx, &result, at, override); err != nil {
				return err
			}
			return h.afterStatusChange(tx, t, &result)
		})
		if err != nil {
			return err
		}
		c.JSON(http.StatusOK, gin.H{"waypoint": h.waypointDTO(&result), "matched_plan": matched, "duplicate": duplicate})
		return nil
	}

	if req.Lng == nil || req.Lat == nil || !geo.ValidCoord(*req.Lng, *req.Lat) {
		return errBad("请提供当前位置坐标 lng / lat")
	}
	ct, err := coordType(req.CoordType, "gcj02")
	if err != nil {
		return err
	}
	lng, lat := geo.ToGCJ02(*req.Lng, *req.Lat, ct)

	// Build the unplanned waypoint up-front (outside the transaction, since
	// reverse geocoding may hit the network); only used if no plan matches.
	in := waypointInput{Lng: &lng, Lat: &lat, CoordType: "gcj02"}
	if req.Name != "" {
		in.Name = &req.Name
	}
	if req.Address != "" {
		in.Address = &req.Address
	}
	if req.AmapID != "" {
		in.AmapID = &req.AmapID
	}
	if req.Category != "" {
		in.Category = &req.Category
	}
	if req.Note != "" {
		in.Note = &req.Note
	}
	planned := false
	in.Planned = &planned
	extra := model.Waypoint{TripID: t.ID, CreatedByID: currentUserID(c)}
	ch, err := h.applyWaypoint(c, t, &extra, &in, true)
	if err != nil {
		return err
	}
	extra.ArrivedAt = &at

	var existing []model.Waypoint
	if err := db.Where("trip_id = ?", t.ID).Order("seq, id").Find(&existing).Error; err != nil {
		return err
	}
	name, amapID := strings.TrimSpace(req.Name), strings.TrimSpace(req.AmapID)
	located := false
	if w, _ := checkinTarget(existing, lng, lat, at, name, amapID); w == nil {
		h.locateWaypoint(ctx, &extra, ch, &in)
		located = true
	}

	err = db.Transaction(func(tx *gorm.DB) error {
		if err := service.LockTrip(tx, t.ID); err != nil {
			return err
		}
		var wps []model.Waypoint
		if err := tx.Where("trip_id = ?", t.ID).Order("seq, id").Find(&wps).Error; err != nil {
			return err
		}
		m, dup := checkinTarget(wps, lng, lat, at, name, amapID)
		if dup { // repeats a visit: return it unchanged
			result, matched, duplicate = *m, m.Planned, true
			return nil
		}
		if m != nil {
			result, matched = *m, true
			if err := markVisited(tx, &result, at, true); err != nil {
				return err
			}
			return h.afterStatusChange(tx, t, &result)
		}
		if !located { // the planned stop was checked in concurrently
			h.locateWaypoint(ctx, &extra, ch, &in)
		}
		// Insert right after the most recently visited waypoint: the end of the
		// actual route (by arrival time when every visited stop has one, else by seq).
		var last *model.Waypoint
		if route := service.ActualRoute(wps); len(route) > 0 {
			last = &route[len(route)-1]
		}
		seq := 0
		if last != nil {
			seq = last.Seq + 1
			extra.Day = last.Day
		}
		if d := service.DayOfTrip(t.StartDate, &at, h.loc); d > 0 {
			extra.Day = d
		}
		if err := h.saveNewWaypoint(tx, &extra, &seq); err != nil {
			return err
		}
		result = extra
		return h.afterStatusChange(tx, t, &result)
	})
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{"waypoint": h.waypointDTO(&result), "matched_plan": matched, "duplicate": duplicate})
	return nil
}

// afterStatusChange starts the trip if needed and refreshes statistics.
func (h *Handler) afterStatusChange(tx *gorm.DB, t *model.Trip, wp *model.Waypoint) error {
	if wp.Status == model.WPVisited {
		if err := startTripIfPlanning(tx, t); err != nil {
			return err
		}
	}
	if err := h.svc.RecomputeTrip(tx, t.ID); err != nil {
		return err
	}
	return h.svc.RecomputePlaces(tx, service.PlaceIDs(wp.PlaceID))
}

func (h *Handler) waypointCheckin(c *gin.Context) error {
	wp, t, err := h.waypointForEdit(c)
	if err != nil {
		return err
	}
	var req struct {
		ArrivedAt string `json:"arrived_at"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	at, override := time.Now(), false
	if req.ArrivedAt != "" {
		p, err := parseTime(req.ArrivedAt, "arrived_at", h.loc)
		if err != nil {
			return err
		}
		at, override = *p, true
	}
	err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		if err := lockWaypoint(tx, wp); err != nil {
			return err
		}
		if err := markVisited(tx, wp, at, override); err != nil {
			return err
		}
		return h.afterStatusChange(tx, t, wp)
	})
	if err != nil {
		return err
	}
	return h.respondWaypoint(c, wp.ID)
}

func (h *Handler) setPlanStatus(c *gin.Context, status string) error {
	wp, t, err := h.waypointForEdit(c)
	if err != nil {
		return err
	}
	if !wp.Planned {
		return errBad("只有计划内的打卡点可以执行此操作")
	}
	err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		if err := lockWaypoint(tx, wp); err != nil {
			return err
		}
		if !wp.Planned {
			return errBad("只有计划内的打卡点可以执行此操作")
		}
		wp.Status, wp.ArrivedAt = status, nil
		if err := tx.Model(wp).Updates(map[string]any{"status": status, "arrived_at": nil}).Error; err != nil {
			return err
		}
		return h.afterStatusChange(tx, t, wp)
	})
	if err != nil {
		return err
	}
	return h.respondWaypoint(c, wp.ID)
}

func (h *Handler) waypointSkip(c *gin.Context) error  { return h.setPlanStatus(c, model.WPSkipped) }
func (h *Handler) waypointReset(c *gin.Context) error { return h.setPlanStatus(c, model.WPTodo) }

// positionFromQuery reads optional lng/lat/coord_type query parameters (GCJ-02 result).
func positionFromQuery(c *gin.Context) (*geo.Point, error) {
	lng, ok1 := queryFloat(c, "lng")
	lat, ok2 := queryFloat(c, "lat")
	if !ok1 || !ok2 {
		return nil, nil
	}
	if !geo.ValidCoord(lng, lat) {
		return nil, errBad("坐标无效")
	}
	ct, err := coordType(c.Query("coord_type"), "gcj02")
	if err != nil {
		return nil, err
	}
	glng, glat := geo.ToGCJ02(lng, lat, ct)
	return &geo.Point{Lng: glng, Lat: glat}, nil
}

func (h *Handler) recommend(c *gin.Context) error {
	t, _, err := h.tripForEdit(c)
	if err != nil {
		return err
	}
	pos, err := positionFromQuery(c)
	if err != nil {
		return err
	}
	useAI := queryBool(c, "ai") && h.svc.AI.Enabled() && h.aiLimit.Allow(fmt.Sprintf("u%d", currentUserID(c)))
	res, err := h.svc.Recommend(c.Request.Context(), t, pos, useAI, time.Now())
	if err != nil {
		return err
	}
	var next *WaypointDTO
	if res.NextPlanned != nil {
		d := h.waypointDTO(res.NextPlanned)
		next = &d
	}
	c.JSON(http.StatusOK, gin.H{
		"next_planned": next, "next_planned_distance_m": res.NextPlannedDistanceM,
		"suggestions": res.Suggestions, "warnings": res.Warnings,
		"ai_text": res.AIText, "ai_used": res.AIUsed,
	})
	return nil
}

func (h *Handler) compare(c *gin.Context) error {
	t, a, err := h.tripForView(c)
	if err != nil {
		return err
	}
	var wps []model.Waypoint
	if err := h.db.WithContext(c.Request.Context()).Where("trip_id = ?", t.ID).Order("seq, id").Find(&wps).Error; err != nil {
		return err
	}
	trackKm := t.TrackDistanceKm
	if a.HideLive(t) {
		wps, trackKm = redactLive(wps), 0
	}
	planned := service.PlannedRoute(wps)
	actual := service.ActualRoute(wps)
	visited, skipped, todo, extra := []model.Waypoint{}, []model.Waypoint{}, []model.Waypoint{}, []model.Waypoint{}
	type dayStat struct {
		Day     int `json:"day"`
		Planned int `json:"planned"`
		Visited int `json:"visited"`
		Extra   int `json:"extra"`
	}
	days := map[int]*dayStat{}
	stat := func(d int) *dayStat {
		if days[d] == nil {
			days[d] = &dayStat{Day: d}
		}
		return days[d]
	}
	type timeDiff struct {
		WaypointID   int64  `json:"waypoint_id"`
		Name         string `json:"name"`
		PlannedAt    string `json:"planned_at"`
		ArrivedAt    string `json:"arrived_at"`
		DeltaMinutes int    `json:"delta_minutes"`
	}
	diffs := []timeDiff{}
	for _, w := range wps {
		if !w.Planned {
			extra = append(extra, w)
			stat(w.Day).Extra++
			continue
		}
		stat(w.Day).Planned++
		switch w.Status {
		case model.WPVisited:
			visited = append(visited, w)
			stat(w.Day).Visited++
			if w.PlannedAt != nil && w.ArrivedAt != nil {
				diffs = append(diffs, timeDiff{WaypointID: w.ID, Name: w.Name, PlannedAt: h.ts(*w.PlannedAt),
					ArrivedAt: h.ts(*w.ArrivedAt), DeltaMinutes: int(math.Round(w.ArrivedAt.Sub(*w.PlannedAt).Minutes()))})
			}
		case model.WPSkipped:
			skipped = append(skipped, w)
		default:
			todo = append(todo, w)
		}
	}
	dayList := make([]dayStat, 0, len(days))
	for _, d := range days {
		dayList = append(dayList, *d)
	}
	slices.SortFunc(dayList, func(a, b dayStat) int { return a.Day - b.Day })
	rate := 0.0
	if len(planned) > 0 {
		rate = geo.Round(float64(len(visited))/float64(len(planned)), 4)
	}
	c.JSON(http.StatusOK, gin.H{
		"planned": gin.H{"count": len(planned), "distance_km": service.RouteKm(planned), "path": service.RoutePath(planned)},
		"actual": gin.H{"count": len(actual), "distance_km": service.RouteKm(actual),
			"track_distance_km": geo.Round(trackKm, 2), "path": service.RoutePath(actual)},
		"completion_rate": rate,
		"visited":         h.waypointDTOs(visited), "skipped": h.waypointDTOs(skipped),
		"todo": h.waypointDTOs(todo), "extra": h.waypointDTOs(extra),
		"days": dayList, "time_diffs": diffs,
	})
	return nil
}

// legs returns the way and travel time between consecutive planned stops of
// each day, planned by 高德 or estimated (see service.TripLegs).
func (h *Handler) legs(c *gin.Context) error {
	t, _, err := h.tripForView(c)
	if err != nil {
		return err
	}
	mode := c.DefaultQuery("mode", "transit")
	if !slices.Contains(service.LegModes, mode) {
		return errBad("mode 取值 walking / transit / driving")
	}
	var wps []model.Waypoint
	if err := h.db.WithContext(c.Request.Context()).Select("id", "seq", "day", "planned", "city", "lng", "lat").
		Where("trip_id = ? AND planned", t.ID).Order("seq, id").Find(&wps).Error; err != nil {
		return err
	}
	c.JSON(http.StatusOK, h.svc.TripLegs(c.Request.Context(), wps, mode))
	return nil
}

func (h *Handler) aiPlan(c *gin.Context) error {
	if !h.svc.AI.Enabled() {
		return errBad("未配置 AI 服务")
	}
	var req struct {
		Destination string `json:"destination"`
		Days        int    `json:"days"`
		Preferences string `json:"preferences"`
		StartDate   string `json:"start_date"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	dest, err := clean(req.Destination, "目的地", 30, true)
	if err != nil {
		return err
	}
	if req.Days == 0 {
		req.Days = 3
	}
	if req.Days < 1 || req.Days > 15 {
		return errBad("天数范围为 1–15 天")
	}
	prefs, err := clean(req.Preferences, "偏好", 300, false)
	if err != nil {
		return err
	}
	if _, err := parseDate(req.StartDate, "start_date"); err != nil {
		return err
	}
	if !h.aiLimit.Allow(fmt.Sprintf("u%d", currentUserID(c))) {
		return errTooMany("AI 使用过于频繁，请稍后再试")
	}
	res, err := h.svc.AIPlan(c.Request.Context(), service.PlanRequest{
		Destination: dest, Days: req.Days, Preferences: prefs, StartDate: strings.TrimSpace(req.StartDate),
	})
	if err != nil {
		slog.Warn("ai plan failed", "err", err)
		if errors.Is(err, context.DeadlineExceeded) {
			return &apiError{http.StatusInternalServerError, "internal", "AI 服务响应超时，请稍后再试"}
		}
		if errors.Is(err, ai.ErrNoJSON) {
			return &apiError{http.StatusInternalServerError, "internal", "AI 返回的内容无法解析，请重试"}
		}
		return &apiError{http.StatusInternalServerError, "internal", "AI 服务暂时不可用，请稍后再试"}
	}
	c.JSON(http.StatusOK, res)
	return nil
}
