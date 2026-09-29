package handler

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"triphub/internal/geo"
	"triphub/internal/model"
	"triphub/internal/service"
)

const maxBatchWaypoints = 200

// relocateRadius: moving an existing waypoint farther than this (metres) makes it a
// different place — its AMap POI link and address are dropped unless the request supplies them.
const relocateRadius = 500.0

// waypointInput is the create/update request body.
type waypointInput struct {
	Name      *string     `json:"name"`
	Address   *string     `json:"address"`
	Lng       *float64    `json:"lng"`
	Lat       *float64    `json:"lat"`
	CoordType string      `json:"coord_type"`
	Day       *int        `json:"day"`
	Kind      *string     `json:"kind"`
	Category  *string     `json:"category"`
	Planned   *bool       `json:"planned"`
	Status    *string     `json:"status"`
	PlannedAt Opt[string] `json:"planned_at"`
	ArrivedAt Opt[string] `json:"arrived_at"`
	Note      *string     `json:"note"`
	Verdict   *string     `json:"verdict"`
	Rating    *int        `json:"rating"`
	Cost      *float64    `json:"cost"`
	AmapID    *string     `json:"amap_id"`
	Seq       *int        `json:"seq"`
	// Optional hints, e.g. copied from /geo/search results.
	Province *string `json:"province"`
	City     *string `json:"city"`
	District *string `json:"district"`
}

// wpChange records what an input changed, for follow-up work.
type wpChange struct {
	coords       bool // position changed → re-locate
	renamed      bool // name set to a different value (or cleared) → re-name
	relink       bool // name / amap_id / position changed → re-resolve Place
	wantDetail   bool // district/address should come from reverse geocoding
	addressGiven bool // user supplied a non-empty address
}

// applyWaypoint validates in and applies it to wp.
func (h *Handler) applyWaypoint(c *gin.Context, t *model.Trip, wp *model.Waypoint, in *waypointInput, creating bool) (wpChange, error) {
	var ch wpChange
	if in.Name != nil {
		s, err := clean(*in.Name, "名称", 100, false)
		if err != nil {
			return ch, err
		}
		// The current name sent back unchanged (e.g. an app re-sending the whole
		// form) is no rename: an auto name such as "西湖区" must not become a
		// user-given name, which would create a Place for it.
		if creating || s != wp.Name {
			wp.Name, ch.relink = s, true
			wp.AutoNamed = s == ""
			ch.renamed = true
		}
	} else if creating {
		wp.AutoNamed = true
	}
	addressGiven := false
	if in.Address != nil {
		s, err := clean(*in.Address, "地址", 200, false)
		if err != nil {
			return ch, err
		}
		wp.Address, addressGiven = s, s != ""
	}
	if in.Lng != nil || in.Lat != nil || creating {
		if in.Lng == nil || in.Lat == nil {
			return ch, errBad("请提供打卡点坐标 lng / lat")
		}
		ct, err := coordType(in.CoordType, "gcj02")
		if err != nil {
			return ch, err
		}
		if !geo.ValidCoord(*in.Lng, *in.Lat) {
			return ch, errBad("坐标无效")
		}
		lng, lat := geo.ToGCJ02(*in.Lng, *in.Lat, ct)
		d := geo.Haversine(lng, lat, wp.Lng, wp.Lat)
		if creating || d > 0.5 {
			if !creating && d > relocateRadius {
				if in.AmapID == nil {
					wp.AmapID = "" // no longer at that POI; ResolvePlace re-links by name + new position
				}
				if in.Address == nil {
					wp.Address = "" // stale; refilled by reverse geocoding when an AMap key is configured
				}
			}
			wp.Lng, wp.Lat = lng, lat
			ch.coords, ch.relink = true, true
		}
	}
	if in.District != nil {
		s, err := clean(*in.District, "区县", 50, false)
		if err != nil {
			return ch, err
		}
		wp.District = s
	} else if ch.coords && !creating && h.svc.CanReverseGeocode() {
		wp.District = "" // moved: refresh from reverse geocoding
	}
	ch.addressGiven = addressGiven
	if ch.coords && (wp.Address == "" || wp.District == "") {
		ch.wantDetail = true
	}
	if in.Day != nil {
		if *in.Day < 0 || *in.Day > 365 {
			return ch, errBad("day 取值范围为 0–365")
		}
		wp.Day = *in.Day
	}
	if in.Kind != nil {
		k := strings.TrimSpace(*in.Kind)
		if k == "" {
			k = model.KindStop
		}
		if k != model.KindStop && k != model.KindLodging {
			return ch, errBad("kind 只能是 stop / lodging")
		}
		wp.Kind = k
	} else if creating {
		wp.Kind = model.KindStop
	}
	if in.Category != nil {
		c := strings.TrimSpace(*in.Category)
		if c == "" {
			c = "other"
		}
		if !slices.Contains(model.Categories, c) {
			return ch, errBad("category 无效")
		}
		wp.Category = c
	} else if creating {
		wp.Category = "other"
		if wp.IsLodging() {
			wp.Category = "hotel"
		}
	}

	// Planned / status / times.
	prevStatus := wp.Status
	if creating {
		wp.Planned = t.Phase == model.PhasePlanning
	}
	if in.Planned != nil {
		wp.Planned = *in.Planned
	}
	if wp.IsLodging() {
		wp.Planned = true // where to sleep is part of the plan
	}
	if in.Status != nil {
		s := strings.TrimSpace(*in.Status)
		if s != model.WPTodo && s != model.WPVisited && s != model.WPSkipped {
			return ch, errBad("status 只能是 todo / visited / skipped")
		}
		wp.Status = s
	} else if creating {
		wp.Status = model.WPVisited
		if wp.Planned {
			wp.Status = model.WPTodo
		}
	}
	if !wp.Planned {
		wp.Status = model.WPVisited // unplanned stops are always visited
	}
	if in.PlannedAt.Set {
		var err error
		if wp.PlannedAt, err = parseTime(in.PlannedAt.V, "planned_at", h.loc); err != nil {
			return ch, err
		}
	}
	if in.ArrivedAt.Set {
		var err error
		if wp.ArrivedAt, err = parseTime(in.ArrivedAt.V, "arrived_at", h.loc); err != nil {
			return ch, err
		}
	}
	if wp.Status != model.WPVisited {
		wp.ArrivedAt = nil
	} else if wp.ArrivedAt == nil && !in.ArrivedAt.Set && prevStatus != model.WPVisited {
		// Newly visited: default to now, except when writing up a finished trip afterwards.
		if !(creating && t.Phase == model.PhaseFinished) {
			now := time.Now()
			wp.ArrivedAt = &now
		}
	}

	if in.Note != nil {
		s, err := clean(*in.Note, "备注", 5000, false)
		if err != nil {
			return ch, err
		}
		wp.Note = s
	}
	if in.Verdict != nil {
		v := strings.TrimSpace(*in.Verdict)
		if v != "" && v != model.VerdictRecommend && v != model.VerdictNeutral && v != model.VerdictAvoid {
			return ch, errBad("verdict 只能是 recommend / neutral / avoid 或空")
		}
		wp.Verdict = v
	}
	if in.Rating != nil {
		if *in.Rating < 0 || *in.Rating > 5 {
			return ch, errBad("评分范围为 0–5")
		}
		wp.Rating = *in.Rating
	}
	if in.Cost != nil {
		if *in.Cost < 0 || *in.Cost > 1_000_000 {
			return ch, errBad("人均花费无效")
		}
		wp.Cost = geo.Round(*in.Cost, 2)
	}
	if in.AmapID != nil {
		s := strings.TrimSpace(*in.AmapID)
		if len(s) > 64 {
			return ch, errBad("amap_id 无效")
		}
		if s != wp.AmapID {
			wp.AmapID, ch.relink = s, true
		}
	}
	if creating {
		ch.relink = true
	}
	var texts []string
	if in.Name != nil {
		texts = append(texts, wp.Name)
	}
	if in.Address != nil {
		texts = append(texts, wp.Address)
	}
	if in.Note != nil {
		texts = append(texts, wp.Note)
	}
	return ch, h.screen(c, texts...)
}

// locateWaypoint fills province/city (offline atlas) and, when requested and
// available, district/address from reverse geocoding; auto-named waypoints
// get a name from the user's address, the spot at the point (the AOI it is
// in or a POI within 30 m) or the district/street. It also fetches
// AMap's data for a new amap_id (see service.WarmPOI), all before the caller
// takes the trip lock.
func (h *Handler) locateWaypoint(ctx context.Context, wp *model.Waypoint, ch wpChange, in *waypointInput) {
	if ch.relink {
		h.svc.WarmPOI(ctx, wp.AmapID)
	}
	var info service.GeoInfo
	if ch.coords {
		info = h.svc.Locate(ctx, wp.Lng, wp.Lat, ch.wantDetail)
		wp.Province, wp.ProvinceCode, wp.City, wp.CityCode = info.Province, info.ProvinceCode, info.City, info.CityCode
		if !info.Found && in != nil {
			if in.Province != nil {
				wp.Province = service.Truncate(strings.TrimSpace(*in.Province), 30)
			}
			if in.City != nil {
				wp.City = service.Truncate(strings.TrimSpace(*in.City), 30)
			}
		}
		if wp.District == "" {
			wp.District = info.District
		}
		if wp.Address == "" && info.Address != "" {
			wp.Address = service.Truncate(info.Address, 200)
		}
	}
	if !wp.AutoNamed && strings.TrimSpace(wp.Name) != "" {
		return
	}
	wp.AutoNamed = true
	switch {
	case ch.addressGiven:
		wp.Name = service.Truncate(wp.Address, 60)
	case info.Spot != "":
		wp.Name = service.Truncate(info.Spot, 60) // the scenic area / shop the point is in or at
	case info.District != "" && info.Street != "":
		wp.Name = info.District + "·" + info.Street
	case wp.District != "":
		wp.Name = wp.District
	case wp.City != "":
		wp.Name = wp.City
	case wp.Province != "":
		wp.Name = wp.Province
	default:
		wp.Name = "未命名地点"
	}
}

// checkLodging validates a lodging (the trip must be locked): its night is
// 0 (the night before day 1) to the trip's days, and no other lodging has
// it. Without dates the days are the planned ones or the latest day of the
// trip's stops (also those just added by the same batch).
func checkLodging(tx *gorm.DB, wp *model.Waypoint) error {
	if !wp.IsLodging() {
		return nil
	}
	var t model.Trip
	if err := tx.Select("id", "start_date", "end_date", "plan_days").First(&t, wp.TripID).Error; err != nil {
		return err
	}
	days := service.DateSpan(t.StartDate, t.EndDate)
	if days == 0 {
		var maxDay int
		if err := tx.Model(&model.Waypoint{}).Where("trip_id = ? AND kind <> ?", wp.TripID, model.KindLodging).
			Select("COALESCE(MAX(day), 0)").Scan(&maxDay).Error; err != nil {
			return err
		}
		days = max(t.PlanDays, maxDay)
	}
	switch {
	case days > 0 && wp.Day > days:
		return errBad(fmt.Sprintf("住宿的 day 超出了旅程天数：共 %d 天，住宿的 day 取值 0–%d（第 N 天晚上住的地方，0 为出发前一晚）", days, days))
	case days == 0 && wp.Day < 1:
		return errBad("请先设置旅程天数，或指定住宿是第几天晚上（day ≥ 1）")
	}
	var n int64
	if err := tx.Model(&model.Waypoint{}).Where("trip_id = ? AND kind = ? AND day = ? AND id <> ?", wp.TripID, model.KindLodging, wp.Day, wp.ID).
		Count(&n).Error; err != nil {
		return err
	}
	if n > 0 {
		return errConflict(nightName(wp.Day) + "已有住宿，请先修改或删除原来的住宿")
	}
	return nil
}

// nightName names a lodging's night: 第 N 天晚上, or 出发前一晚 for night 0.
func nightName(day int) string {
	if day == 0 {
		return "出发前一晚"
	}
	return fmt.Sprintf("第 %d 天晚上", day)
}

// tripOrder returns a trip's waypoint IDs in seq order and the day of each.
func tripOrder(tx *gorm.DB, tripID int64) ([]int64, map[int64]int, error) {
	var rows []struct {
		ID  int64
		Day int
	}
	if err := tx.Model(&model.Waypoint{}).Select("id", "day").Where("trip_id = ?", tripID).Order("seq, id").Scan(&rows).Error; err != nil {
		return nil, nil, err
	}
	ids := make([]int64, len(rows))
	dayOf := make(map[int64]int, len(rows))
	for i, r := range rows {
		ids[i], dayOf[r.ID] = r.ID, r.Day
	}
	return ids, dayOf, nil
}

// saveNewWaypoint inserts a prepared waypoint inside tx (trip must be
// locked); a lodging without seq goes after its day (service.LodgingSeq).
func (h *Handler) saveNewWaypoint(tx *gorm.DB, wp *model.Waypoint, seq *int) error {
	if err := checkLodging(tx, wp); err != nil {
		return err
	}
	if wp.IsLodging() && seq == nil {
		ids, dayOf, err := tripOrder(tx, wp.TripID)
		if err != nil {
			return err
		}
		pos := service.LodgingSeq(ids, dayOf, wp.Day)
		seq = &pos
	}
	pid, err := h.svc.ResolvePlace(tx, wp, !wp.AutoNamed, wp.CreatedByID)
	if err != nil {
		return err
	}
	wp.PlaceID = pid
	if err := service.InsertWaypoint(tx, wp, seq); err != nil {
		return err
	}
	return h.svc.AwardExp(tx, wp.CreatedByID, service.ExpKey("waypoint", wp.ID), service.ExpWaypoint, "waypoint")
}

// createNewWaypoint is saveNewWaypoint for a waypoint whose Seq the caller
// has already chosen (later waypoints are not shifted).
func (h *Handler) createNewWaypoint(tx *gorm.DB, wp *model.Waypoint) error {
	if err := checkLodging(tx, wp); err != nil {
		return err
	}
	pid, err := h.svc.ResolvePlace(tx, wp, !wp.AutoNamed, wp.CreatedByID)
	if err != nil {
		return err
	}
	wp.PlaceID = pid
	if err := tx.Create(wp).Error; err != nil {
		return err
	}
	return h.svc.AwardExp(tx, wp.CreatedByID, service.ExpKey("waypoint", wp.ID), service.ExpWaypoint, "waypoint")
}

func (h *Handler) createWaypoint(c *gin.Context) error {
	t, _, err := h.tripForEdit(c)
	if err != nil {
		return err
	}
	var in waypointInput
	if err := bindJSON(c, &in); err != nil {
		return err
	}
	wp := model.Waypoint{TripID: t.ID, CreatedByID: currentUserID(c)}
	ch, err := h.applyWaypoint(c, t, &wp, &in, true)
	if err != nil {
		return err
	}
	h.locateWaypoint(c.Request.Context(), &wp, ch, &in)
	err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		if err := service.LockTrip(tx, t.ID); err != nil {
			return err
		}
		if err := h.saveNewWaypoint(tx, &wp, in.Seq); err != nil {
			return err
		}
		if err := h.svc.RecomputeTrip(tx, t.ID); err != nil {
			return err
		}
		if _, err := service.TouchTrip(tx, t.ID, wp.CreatedByID); err != nil {
			return err
		}
		return h.svc.RecomputePlaces(tx, service.PlaceIDs(wp.PlaceID))
	})
	if err != nil {
		return err
	}
	return h.respondWaypoint(c, wp.ID)
}

func (h *Handler) respondWaypoint(c *gin.Context, id int64) error {
	var wp model.Waypoint
	if err := h.db.WithContext(c.Request.Context()).First(&wp, id).Error; err != nil {
		return err
	}
	c.JSON(http.StatusOK, h.waypointDTO(&wp))
	return nil
}

func (h *Handler) batchWaypoints(c *gin.Context) error {
	t, _, err := h.tripForEdit(c)
	if err != nil {
		return err
	}
	var req struct {
		Items []waypointInput `json:"items"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	if len(req.Items) == 0 {
		return errBad("items 不能为空")
	}
	if len(req.Items) > maxBatchWaypoints {
		return errBad(fmt.Sprintf("单次最多添加 %d 个打卡点", maxBatchWaypoints))
	}
	uid := currentUserID(c)
	wps := make([]model.Waypoint, len(req.Items))
	changes := make([]wpChange, len(req.Items))
	for i := range req.Items {
		wps[i] = model.Waypoint{TripID: t.ID, CreatedByID: uid}
		ch, err := h.applyWaypoint(c, t, &wps[i], &req.Items[i], true)
		if err != nil {
			if ae, ok := err.(*apiError); ok {
				return errBad(fmt.Sprintf("第 %d 项：%s", i+1, ae.Message))
			}
			return err
		}
		changes[i] = ch
	}
	// Locate concurrently (reverse geocoding may involve network calls).
	var wg sync.WaitGroup
	sem := make(chan struct{}, 5)
	ctx := c.Request.Context()
	for i := range wps {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			h.locateWaypoint(ctx, &wps[i], changes[i], &req.Items[i])
		}(i)
	}
	wg.Wait()

	err = h.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := service.LockTrip(tx, t.ID); err != nil {
			return err
		}
		// Positions are chosen in memory as sequential single creates would
		// (service.InsertWaypoint: a seq outside 0..n-1 appends) and written
		// once at the end, instead of shifting the later rows for every item.
		order, dayOf, err := tripOrder(tx, t.ID)
		if err != nil {
			return err
		}
		reordered := false
		var placeIDs []int64
		for i := range wps {
			pos := len(order)
			if s := req.Items[i].Seq; s != nil && *s >= 0 && *s < pos {
				pos, reordered = *s, true
			} else if wps[i].IsLodging() && req.Items[i].Seq == nil {
				if pos = service.LodgingSeq(order, dayOf, wps[i].Day); pos < len(order) {
					reordered = true
				}
			}
			wps[i].Seq = pos
			if err := h.createNewWaypoint(tx, &wps[i]); err != nil {
				if ae, ok := err.(*apiError); ok && len(wps) > 1 {
					return &apiError{ae.Status, ae.Code, fmt.Sprintf("第 %d 项：%s", i+1, ae.Message)}
				}
				return err
			}
			dayOf[wps[i].ID] = wps[i].Day
			order = slices.Insert(order, pos, wps[i].ID)
			placeIDs = append(placeIDs, service.PlaceIDs(wps[i].PlaceID)...)
		}
		if reordered {
			if err := applyOrder(tx, t.ID, order); err != nil {
				return err
			}
		}
		if err := h.svc.RecomputeTrip(tx, t.ID); err != nil {
			return err
		}
		if _, err := service.TouchTrip(tx, t.ID, uid); err != nil {
			return err
		}
		return h.svc.RecomputePlaces(tx, placeIDs)
	})
	if err != nil {
		return err
	}
	ids := make([]int64, len(wps))
	for i := range wps {
		ids[i] = wps[i].ID
	}
	var saved []model.Waypoint
	if err := h.db.WithContext(ctx).Where("id IN ?", ids).Order("seq, id").Find(&saved).Error; err != nil {
		return err
	}
	c.JSON(http.StatusOK, h.waypointDTOs(saved))
	return nil
}

// waypointForEdit loads the :id waypoint and its trip, requiring membership.
func (h *Handler) waypointForEdit(c *gin.Context) (*model.Waypoint, *model.Trip, error) {
	wp, t, err := h.findWaypointForEdit(c)
	if err == nil && wp == nil {
		return nil, nil, errNotFound("打卡点不存在")
	}
	return wp, t, err
}

// findWaypointForEdit is waypointForEdit, but a waypoint that does not
// exist (any more) is no error: all three results are nil.
func (h *Handler) findWaypointForEdit(c *gin.Context) (*model.Waypoint, *model.Trip, error) {
	id, err := idParam(c, "id")
	if err != nil {
		return nil, nil, err
	}
	var wp model.Waypoint
	if err := h.db.WithContext(c.Request.Context()).Limit(1).Find(&wp, id).Error; err != nil {
		return nil, nil, err
	}
	if wp.ID == 0 {
		return nil, nil, nil
	}
	t, a, err := h.loadTrip(c, wp.TripID, "")
	if err != nil {
		if _, ok := err.(*apiError); ok {
			return nil, nil, errNotFound("打卡点不存在")
		}
		return nil, nil, err
	}
	if !a.CanEdit() {
		return nil, nil, errNotMember
	}
	return &wp, t, nil
}

// lockWaypoint takes the lock of wp's trip and reloads wp, so that changes
// committed by concurrent requests are seen (404 if it was deleted).
func lockWaypoint(tx *gorm.DB, wp *model.Waypoint) error {
	if err := service.LockTrip(tx, wp.TripID); err != nil {
		return err
	}
	var cur model.Waypoint
	if err := tx.Limit(1).Find(&cur, wp.ID).Error; err != nil {
		return err
	}
	if cur.ID == 0 {
		return errNotFound("打卡点不存在")
	}
	*wp = cur
	return nil
}

// changedWaypointColumns lists the columns whose values differ between a and b.
func changedWaypointColumns(a, b *model.Waypoint) []string {
	var cols []string
	add := func(changed bool, col string) {
		if changed {
			cols = append(cols, col)
		}
	}
	sameTime := func(x, y *time.Time) bool { return x == nil && y == nil || x != nil && y != nil && x.Equal(*y) }
	sameID := func(x, y *int64) bool { return x == nil && y == nil || x != nil && y != nil && *x == *y }
	add(a.Day != b.Day, "day")
	add(a.Kind != b.Kind, "kind")
	add(a.Planned != b.Planned, "planned")
	add(a.Status != b.Status, "status")
	add(!sameTime(a.PlannedAt, b.PlannedAt), "planned_at")
	add(!sameTime(a.ArrivedAt, b.ArrivedAt), "arrived_at")
	add(a.Name != b.Name, "name")
	add(a.Address != b.Address, "address")
	add(a.Province != b.Province, "province")
	add(a.ProvinceCode != b.ProvinceCode, "province_code")
	add(a.City != b.City, "city")
	add(a.CityCode != b.CityCode, "city_code")
	add(a.District != b.District, "district")
	add(a.Lng != b.Lng, "lng")
	add(a.Lat != b.Lat, "lat")
	add(a.Category != b.Category, "category")
	add(a.Note != b.Note, "note")
	add(a.Verdict != b.Verdict, "verdict")
	add(a.Rating != b.Rating, "rating")
	add(a.Cost != b.Cost, "cost")
	add(a.AmapID != b.AmapID, "amap_id")
	add(!sameID(a.PlaceID, b.PlaceID), "place_id")
	add(a.AutoNamed != b.AutoNamed, "auto_named")
	return cols
}

// saveWaypointChanges persists an edited waypoint (orig is how it was
// loaded), re-linking its place (as seen by actorID, the editing user) and
// refreshing trip / place statistics. Only the columns this edit changed are
// written, so that a check-in committed meanwhile (e.g. while the new
// position was reverse-geocoded) is not undone.
func (h *Handler) saveWaypointChanges(ctx context.Context, wp, orig *model.Waypoint, relink bool, actorID int64) error {
	return h.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		cur := *wp
		if err := lockWaypoint(tx, &cur); err != nil {
			return err
		}
		if wp.Kind != orig.Kind || wp.Day != orig.Day {
			if err := checkLodging(tx, wp); err != nil {
				return err
			}
		}
		if relink {
			pid, err := h.svc.ResolvePlace(tx, wp, !wp.AutoNamed, actorID)
			if err != nil {
				return err
			}
			wp.PlaceID = pid
		}
		if cols := changedWaypointColumns(orig, wp); len(cols) > 0 {
			if err := tx.Model(&model.Waypoint{ID: wp.ID}).Select(cols).Updates(wp).Error; err != nil {
				return err
			}
			if _, err := service.TouchTrip(tx, wp.TripID, actorID); err != nil {
				return err
			}
		}
		if err := h.svc.RecomputeTrip(tx, wp.TripID); err != nil {
			return err
		}
		return h.svc.RecomputePlaces(tx, service.PlaceIDs(orig.PlaceID, cur.PlaceID, wp.PlaceID))
	})
}

func (h *Handler) updateWaypoint(c *gin.Context) error {
	wp, t, err := h.waypointForEdit(c)
	if err != nil {
		return err
	}
	var in waypointInput
	if err := bindJSON(c, &in); err != nil {
		return err
	}
	orig := *wp
	ch, err := h.applyWaypoint(c, t, wp, &in, false)
	if err != nil {
		return err
	}
	if ch.coords || ch.renamed {
		h.locateWaypoint(c.Request.Context(), wp, ch, &in)
	} else if ch.relink {
		h.svc.WarmPOI(c.Request.Context(), wp.AmapID)
	}
	uid := currentUserID(c)
	if err := h.saveWaypointChanges(c.Request.Context(), wp, &orig, ch.relink, uid); err != nil {
		return err
	}
	switch {
	case in.Seq != nil && *in.Seq != wp.Seq:
		if err := h.moveWaypoint(c.Request.Context(), wp, *in.Seq, uid); err != nil {
			return err
		}
	case wp.IsLodging() && (wp.Kind != orig.Kind || wp.Day != orig.Day):
		if err := h.moveWaypoint(c.Request.Context(), wp, -1, uid); err != nil { // after its day
			return err
		}
	}
	return h.respondWaypoint(c, wp.ID)
}

// moveWaypoint moves a waypoint to position seq within its trip; -1 moves
// a lodging to the place of its night (service.LodgingSeq). actorID is the
// user moving it.
func (h *Handler) moveWaypoint(ctx context.Context, wp *model.Waypoint, seq int, actorID int64) error {
	return h.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := service.LockTrip(tx, wp.TripID); err != nil {
			return err
		}
		ids, dayOf, err := tripOrder(tx, wp.TripID)
		if err != nil {
			return err
		}
		before := slices.Clone(ids)
		ids = slices.DeleteFunc(ids, func(id int64) bool { return id == wp.ID })
		if seq == -1 && wp.IsLodging() {
			seq = service.LodgingSeq(ids, dayOf, wp.Day)
		}
		if seq < 0 {
			seq = 0
		}
		if seq > len(ids) {
			seq = len(ids)
		}
		ids = slices.Insert(ids, seq, wp.ID)
		if slices.Equal(ids, before) {
			return nil
		}
		if err := applyOrder(tx, wp.TripID, ids); err != nil {
			return err
		}
		if err := h.svc.RecomputeTrip(tx, wp.TripID); err != nil {
			return err
		}
		_, err = service.TouchTrip(tx, wp.TripID, actorID)
		return err
	})
}

func applyOrder(tx *gorm.DB, tripID int64, ids []int64) error {
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = strconv.FormatInt(id, 10)
	}
	return tx.Exec("UPDATE waypoints SET seq = array_position(?::bigint[], id) - 1 WHERE trip_id = ?",
		"{"+strings.Join(parts, ",")+"}", tripID).Error
}

// removeWaypoint deletes waypoint wid of trip tripID, taking the trip lock:
// its photos and comments are kept, unlinked, and a revision of the trip is
// counted. A waypoint that is not there (any more) is no error; removed
// then reports false.
func (h *Handler) removeWaypoint(tx *gorm.DB, tripID, wid, actorID int64) (removed bool, err error) {
	if err := service.LockTrip(tx, tripID); err != nil {
		return false, err
	}
	var wp model.Waypoint
	if err := tx.Where("id = ? AND trip_id = ?", wid, tripID).Limit(1).Find(&wp).Error; err != nil {
		return false, err
	}
	if wp.ID == 0 {
		return false, nil
	}
	if err := service.DeleteWaypoints(tx, tripID, []int64{wp.ID}); err != nil {
		return false, err
	}
	if err := h.svc.RecomputeTrip(tx, tripID); err != nil {
		return false, err
	}
	if _, err := service.TouchTrip(tx, tripID, actorID); err != nil {
		return false, err
	}
	return true, h.svc.RecomputePlaces(tx, service.PlaceIDs(wp.PlaceID))
}

// deleteWaypoint is DELETE /waypoints/:id. It is idempotent: a waypoint
// that no longer exists (a second tap on 删除 while the first request was
// under way, or deleted by another member) answers {} like a deletion.
func (h *Handler) deleteWaypoint(c *gin.Context) error {
	wp, _, err := h.findWaypointForEdit(c)
	if err != nil {
		return err
	}
	if wp != nil {
		err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
			_, err := h.removeWaypoint(tx, wp.TripID, wp.ID, currentUserID(c))
			return err
		})
		if err != nil {
			return err
		}
	}
	c.JSON(http.StatusOK, gin.H{})
	return nil
}

// deleteTripWaypoint is DELETE /trips/:id/waypoints/:wid: the waypoint is
// gone afterwards, whether this request deleted it or it was deleted
// before (or is not in this trip), so the answer is always 204 for a
// member of the trip.
func (h *Handler) deleteTripWaypoint(c *gin.Context) error {
	t, _, err := h.tripForEdit(c)
	if err != nil {
		return err
	}
	wid, err := idParam(c, "wid")
	if err != nil {
		return err
	}
	err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		_, err := h.removeWaypoint(tx, t.ID, wid, currentUserID(c))
		return err
	})
	if err != nil {
		return err
	}
	c.Status(http.StatusNoContent)
	return nil
}

func (h *Handler) orderWaypoints(c *gin.Context) error {
	t, _, err := h.tripForEdit(c)
	if err != nil {
		return err
	}
	var req struct {
		IDs []int64 `json:"ids"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	ctx := c.Request.Context()
	err = h.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := service.LockTrip(tx, t.ID); err != nil {
			return err
		}
		var existing []int64
		if err := tx.Model(&model.Waypoint{}).Where("trip_id = ?", t.ID).Pluck("id", &existing).Error; err != nil {
			return err
		}
		if len(existing) != len(req.IDs) {
			return errBad("ids 必须包含该旅程的全部打卡点")
		}
		set := map[int64]bool{}
		for _, id := range existing {
			set[id] = true
		}
		seen := map[int64]bool{}
		for _, id := range req.IDs {
			if !set[id] || seen[id] {
				return errBad("ids 必须包含该旅程的全部打卡点且不能重复")
			}
			seen[id] = true
		}
		cur, _, err := tripOrder(tx, t.ID)
		if err != nil {
			return err
		}
		if slices.Equal(cur, req.IDs) {
			return nil
		}
		if err := applyOrder(tx, t.ID, req.IDs); err != nil {
			return err
		}
		if err := h.svc.RecomputeTrip(tx, t.ID); err != nil {
			return err
		}
		_, err = service.TouchTrip(tx, t.ID, currentUserID(c))
		return err
	})
	if err != nil {
		return err
	}
	var wps []model.Waypoint
	if err := h.db.WithContext(ctx).Where("trip_id = ?", t.ID).Order("seq, id").Find(&wps).Error; err != nil {
		return err
	}
	c.JSON(http.StatusOK, h.waypointDTOs(wps))
	return nil
}
