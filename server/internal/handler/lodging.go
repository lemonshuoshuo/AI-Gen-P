package handler

import (
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"triphub/internal/model"
	"triphub/internal/service"
)

// maxLodgingNights bounds the nights of one POST /trips/:id/lodging.
const maxLodgingNights = 30

// lodgingRequest is the body of POST /trips/:id/lodging: a waypoint body
// (the hotel), the first night (day) and how many nights in a row.
type lodgingRequest struct {
	waypointInput
	Nights int `json:"nights"`
	// CopyFrom takes the hotel from another waypoint of the trip (e.g. the
	// previous night's lodging): fields given in the request override it.
	CopyFrom *int64 `json:"copy_from"`
	// Replace deletes the lodging these nights already have (else 409).
	Replace bool `json:"replace"`
}

// fillFrom copies the place of src into the fields the request left out.
func (r *lodgingRequest) fillFrom(src *model.Waypoint) {
	str := func(dst **string, v string) {
		if *dst == nil {
			*dst = &v
		}
	}
	if !src.AutoNamed {
		str(&r.Name, src.Name)
	}
	str(&r.Address, src.Address)
	str(&r.AmapID, src.AmapID)
	str(&r.District, src.District)
	str(&r.Province, src.Province)
	str(&r.City, src.City)
	if r.Category == nil && src.Category != "other" {
		str(&r.Category, src.Category)
	}
	if r.Note == nil && src.IsLodging() {
		str(&r.Note, src.Note)
	}
	if r.Cost == nil && src.IsLodging() && src.Cost > 0 {
		c := src.Cost
		r.Cost = &c
	}
	if r.Lng == nil && r.Lat == nil {
		lng, lat := src.Lng, src.Lat
		r.Lng, r.Lat, r.CoordType = &lng, &lat, "gcj02"
	}
}

// createLodging sets the lodging of one or more nights: POST
// /trips/:id/lodging {day, nights?, copy_from?, replace?, name, lng, lat, …}
// → [Waypoint], one lodging per night from night day on.
func (h *Handler) createLodging(c *gin.Context) error {
	t, _, err := h.tripForEdit(c)
	if err != nil {
		return err
	}
	var req lodgingRequest
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	if req.Day == nil {
		return errBad("请指定住宿是第几天晚上（day，0 为出发前一晚）")
	}
	if req.Nights == 0 {
		req.Nights = 1
	}
	if req.Nights < 1 || req.Nights > maxLodgingNights {
		return errBad(fmt.Sprintf("nights 取值 1–%d", maxLodgingNights))
	}
	ctx := c.Request.Context()
	db := h.db.WithContext(ctx)
	if req.CopyFrom != nil {
		var src model.Waypoint
		if err := db.Where("id = ? AND trip_id = ?", *req.CopyFrom, t.ID).Limit(1).Find(&src).Error; err != nil {
			return err
		}
		if src.ID == 0 {
			return errBad("copy_from 不是该旅程的打卡点")
		}
		req.fillFrom(&src)
	}
	kind := model.KindLodging
	req.Kind, req.Seq = &kind, nil
	first := *req.Day
	wp := model.Waypoint{TripID: t.ID, CreatedByID: currentUserID(c)}
	ch, err := h.applyWaypoint(c, t, &wp, &req.waypointInput, true)
	if err != nil {
		return err
	}
	if first+req.Nights-1 > 365 {
		return errBad("day 取值范围为 0–365")
	}
	h.locateWaypoint(ctx, &wp, ch, &req.waypointInput)
	nights := make([]model.Waypoint, req.Nights)
	for i := range nights {
		nights[i] = wp
		nights[i].Day = first + i
	}
	err = db.Transaction(func(tx *gorm.DB) error {
		if err := service.LockTrip(tx, t.ID); err != nil {
			return err
		}
		var placeIDs []int64
		if req.Replace {
			var old []model.Waypoint
			if err := tx.Where("trip_id = ? AND kind = ? AND day BETWEEN ? AND ?", t.ID, model.KindLodging, first, first+req.Nights-1).
				Find(&old).Error; err != nil {
				return err
			}
			ids := make([]int64, len(old))
			for i := range old {
				ids[i] = old[i].ID
				placeIDs = append(placeIDs, service.PlaceIDs(old[i].PlaceID)...)
			}
			if err := service.DeleteWaypoints(tx, t.ID, ids); err != nil {
				return err
			}
		}
		for i := range nights {
			if err := h.saveNewWaypoint(tx, &nights[i], nil); err != nil {
				return err
			}
			placeIDs = append(placeIDs, service.PlaceIDs(nights[i].PlaceID)...)
		}
		if err := h.svc.RecomputeTrip(tx, t.ID); err != nil {
			return err
		}
		return h.svc.RecomputePlaces(tx, placeIDs)
	})
	if err != nil {
		return err
	}
	ids := make([]int64, len(nights))
	for i := range nights {
		ids[i] = nights[i].ID
	}
	var saved []model.Waypoint
	if err := db.Where("id IN ?", ids).Order("day, id").Find(&saved).Error; err != nil {
		return err
	}
	c.JSON(http.StatusOK, h.waypointDTOs(saved))
	return nil
}

// maxArrangeDays bounds the days of POST /trips/:id/arrange.
const maxArrangeDays = 60

// arrange distributes a trip's stops over its days and orders each day
// (see service.PlanArrangement): POST /trips/:id/arrange {scope, mode,
// apply, days?, fixed?}. apply=false only proposes the arrangement.
func (h *Handler) arrange(c *gin.Context) error {
	t, _, err := h.tripForEdit(c)
	if err != nil {
		return err
	}
	var req struct {
		Scope string         `json:"scope"`
		Mode  string         `json:"mode"`
		Apply bool           `json:"apply"`
		Days  *int           `json:"days"`
		Fixed map[string]int `json:"fixed"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	ar := service.ArrangeRequest{Scope: strings.TrimSpace(req.Scope), Mode: strings.TrimSpace(req.Mode), Fixed: map[int64]int{}}
	if ar.Scope == "" {
		ar.Scope = service.ArrangePool
	}
	if ar.Scope != service.ArrangePool && ar.Scope != service.ArrangeAll {
		return errBad("scope 只能是 pool / all")
	}
	if ar.Mode == "" {
		ar.Mode = t.TravelMode
	}
	if ar.Mode == "" {
		ar.Mode = model.TravelAuto
	}
	if !slices.Contains(model.TravelModes, ar.Mode) {
		return errBad("mode 取值 auto / walking / riding / driving / transit")
	}
	if req.Days != nil {
		if *req.Days < 1 || *req.Days > maxArrangeDays {
			return errBad(fmt.Sprintf("days 取值 1–%d", maxArrangeDays))
		}
		if span := service.DateSpan(t.StartDate, t.EndDate); span > 0 && *req.Days > span {
			return errBad(fmt.Sprintf("天数不能超过旅程日期的天数（共 %d 天）", span))
		}
		ar.Days = *req.Days
	}
	for k, d := range req.Fixed {
		id, err := strconv.ParseInt(k, 10, 64)
		if err != nil || id <= 0 {
			return errBad("fixed 的键应为打卡点 ID")
		}
		ar.Fixed[id] = d
	}
	transit := t.TravelMode == "transit"
	ctx := c.Request.Context()
	db := h.db.WithContext(ctx)
	if !req.Apply {
		var wps []model.Waypoint
		if err := db.Where("trip_id = ?", t.ID).Order("seq, id").Find(&wps).Error; err != nil {
			return err
		}
		res, err := service.PlanArrangement(wps, ar, t.Days, transit)
		if err != nil {
			return err
		}
		c.JSON(http.StatusOK, gin.H{"scope": res.Scope, "mode": res.Mode, "days": res.Days, "applied": false,
			"changed": res.Changed, "items": res.Items, "day_totals": res.DayList})
		return nil
	}
	var res *service.Arrangement
	err = db.Transaction(func(tx *gorm.DB) error {
		if err := service.LockTrip(tx, t.ID); err != nil {
			return err
		}
		var cur model.Trip
		if err := tx.Select("id", "days", "plan_days", "start_date", "end_date").First(&cur, t.ID).Error; err != nil {
			return err
		}
		var wps []model.Waypoint
		if err := tx.Where("trip_id = ?", t.ID).Order("seq, id").Find(&wps).Error; err != nil {
			return err
		}
		var err error
		if res, err = service.PlanArrangement(wps, ar, cur.Days, transit); err != nil {
			return err
		}
		// The trip gets the days arranged (dated trips have them already).
		if res.Days > cur.Days && service.DateSpan(cur.StartDate, cur.EndDate) == 0 {
			if err := tx.Model(&model.Trip{}).Where("id = ?", t.ID).Update("plan_days", res.Days).Error; err != nil {
				return err
			}
		}
		old := make(map[int64]int, len(wps))
		for _, w := range wps {
			old[w.ID] = w.Day
		}
		var vals []string
		var args []any
		ids := make([]int64, len(res.Items))
		for i, it := range res.Items {
			ids[i] = it.ID
			if old[it.ID] != it.Day {
				vals = append(vals, "(?::bigint, ?::int)")
				args = append(args, it.ID, it.Day)
			}
		}
		if len(vals) > 0 {
			args = append(args, t.ID)
			if err := tx.Exec("UPDATE waypoints w SET day = v.day FROM (VALUES "+strings.Join(vals, ", ")+
				") AS v(id, day) WHERE w.id = v.id AND w.trip_id = ?", args...).Error; err != nil {
				return err
			}
		}
		if err := applyOrder(tx, t.ID, ids); err != nil {
			return err
		}
		return h.svc.RecomputeTrip(tx, t.ID)
	})
	if err != nil {
		return err
	}
	var wps []model.Waypoint
	if err := db.Where("trip_id = ?", t.ID).Order("seq, id").Find(&wps).Error; err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{"scope": res.Scope, "mode": res.Mode, "days": res.Days, "applied": true,
		"changed": res.Changed, "items": res.Items, "day_totals": res.DayList, "waypoints": h.waypointDTOs(wps)})
	return nil
}
