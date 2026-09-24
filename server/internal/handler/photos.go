package handler

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"triphub/internal/geo"
	"triphub/internal/media"
	"triphub/internal/model"
	"triphub/internal/service"
)

const autoWaypointRadius = 300.0

func formatBytes(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.1f GB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	}
	return fmt.Sprintf("%d KB", n>>10)
}

func quotaError(u *model.User) error {
	return errTooLarge(fmt.Sprintf("存储空间不足（已用 %s / 共 %s），升级等级可获得更多空间",
		formatBytes(u.StorageUsed), formatBytes(service.QuotaBytes(u))))
}

// checkQuota rejects uploads that would obviously exceed the user's quota.
func checkQuota(u *model.User, size int64) error {
	q := service.QuotaBytes(u)
	if q > 0 && u.StorageUsed+size > q {
		return quotaError(u)
	}
	return nil
}

// chargeStorage atomically adds bytes to the user's usage within the quota.
func chargeStorage(tx *gorm.DB, u *model.User, size int64) error {
	q := service.QuotaBytes(u)
	res := tx.Exec("UPDATE users SET storage_used = storage_used + ? WHERE id = ? AND (? = 0 OR storage_used + ? <= ?)",
		size, u.ID, q, size, q)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return quotaError(u)
	}
	return nil
}

func nearestWaypoint(wps []model.Waypoint, lng, lat, radius float64) *model.Waypoint {
	var best *model.Waypoint
	bestD := radius
	for i := range wps {
		if d := geo.Haversine(lng, lat, wps[i].Lng, wps[i].Lat); d <= bestD {
			best, bestD = &wps[i], d
		}
	}
	return best
}

func (h *Handler) uploadPhoto(c *gin.Context) error {
	t, _, err := h.tripForEdit(c)
	if err != nil {
		return err
	}
	data, err := h.readUpload(c)
	if err != nil {
		return err
	}
	u := currentUser(c)
	if err := checkQuota(u, int64(len(data))); err != nil {
		return err
	}
	ctx := c.Request.Context()
	db := h.db.WithContext(ctx)

	caption, err := clean(c.PostForm("caption"), "说明", 500, false)
	if err != nil {
		return err
	}
	ct, err := coordType(c.PostForm("coord_type"), "wgs84")
	if err != nil {
		return err
	}
	var lng, lat *float64
	if ls, as := strings.TrimSpace(c.PostForm("lng")), strings.TrimSpace(c.PostForm("lat")); ls != "" && as != "" {
		x, err1 := strconv.ParseFloat(ls, 64)
		y, err2 := strconv.ParseFloat(as, 64)
		if err1 != nil || err2 != nil || !geo.ValidCoord(x, y) {
			return errBad("坐标无效")
		}
		gx, gy := geo.ToGCJ02(x, y, ct)
		lng, lat = &gx, &gy
	}
	takenAt, err := parseTime(c.PostForm("taken_at"), "taken_at", h.loc)
	if err != nil {
		return err
	}
	if lng == nil || takenAt == nil {
		ex := media.ReadExif(data, h.loc)
		if lng == nil && ex.Lng != nil {
			gx, gy := geo.WGS84ToGCJ02(*ex.Lng, *ex.Lat)
			lng, lat = &gx, &gy
		}
		if takenAt == nil {
			takenAt = ex.TakenAt
		}
	}
	if lng != nil {
		rx, ry := geo.Round(*lng, 6), geo.Round(*lat, 6)
		lng, lat = &rx, &ry
	}
	var linkWP *model.Waypoint
	if v := strings.TrimSpace(c.PostForm("waypoint_id")); v != "" && v != "0" {
		id, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			return errBad("waypoint_id 无效")
		}
		var wp model.Waypoint
		if err := db.Where("id = ? AND trip_id = ?", id, t.ID).Limit(1).Find(&wp).Error; err != nil {
			return err
		}
		if wp.ID == 0 {
			return errBad("打卡点不属于该旅程")
		}
		linkWP = &wp
	}
	auto := linkWP == nil && lng != nil && queryBoolValue(c.PostForm("auto_waypoint"))

	// Reverse-geocode before taking locks when a new waypoint is likely needed.
	var info service.GeoInfo
	if auto {
		var wps []model.Waypoint
		if err := db.Where("trip_id = ?", t.ID).Find(&wps).Error; err != nil {
			return err
		}
		if nearestWaypoint(wps, *lng, *lat, autoWaypointRadius) == nil {
			info = h.svc.Locate(ctx, *lng, *lat, true)
		}
	}

	saved, err := h.svc.Media.SaveImage(data)
	if err != nil {
		return mediaError(err)
	}
	photo := model.Photo{TripID: t.ID, UserID: u.ID, Path: saved.Path, ThumbPath: saved.ThumbPath,
		Width: saved.Width, Height: saved.Height, Size: saved.Size, TakenAt: takenAt, Lng: lng, Lat: lat, Caption: caption}
	var resultWP *model.Waypoint
	created := false
	err = db.Transaction(func(tx *gorm.DB) error {
		if err := service.LockTrip(tx, t.ID); err != nil {
			return err
		}
		if err := chargeStorage(tx, u, saved.Size); err != nil {
			return err
		}
		if linkWP != nil {
			photo.WaypointID, resultWP = &linkWP.ID, linkWP
		} else if auto {
			wp, isNew, err := h.autoWaypoint(ctx, tx, t, u, *lng, *lat, takenAt, info)
			if err != nil {
				return err
			}
			photo.WaypointID, resultWP, created = &wp.ID, wp, isNew
		}
		if err := tx.Create(&photo).Error; err != nil {
			return err
		}
		if err := h.svc.AwardExp(tx, u.ID, service.ExpKey("photo", photo.ID), service.ExpPhoto, "photo"); err != nil {
			return err
		}
		if err := h.svc.RecomputeTrip(tx, t.ID); err != nil {
			return err
		}
		if resultWP != nil {
			return h.svc.RecomputePlaces(tx, service.PlaceIDs(resultWP.PlaceID))
		}
		return nil
	})
	if err != nil {
		h.svc.Media.Remove(saved.Path, saved.ThumbPath)
		return err
	}
	var wpDTO *WaypointDTO
	if resultWP != nil {
		var fresh model.Waypoint
		if err := db.First(&fresh, resultWP.ID).Error; err != nil {
			return err
		}
		d := h.waypointDTO(&fresh)
		wpDTO = &d
	}
	c.JSON(http.StatusOK, gin.H{"photo": h.photoDTO(&photo), "waypoint": wpDTO, "waypoint_created": created})
	return nil
}

func queryBoolValue(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// autoWaypoint links a geotagged photo to a waypoint within 300 m or creates
// an unplanned, visited waypoint inserted chronologically. The trip must be locked.
func (h *Handler) autoWaypoint(ctx context.Context, tx *gorm.DB, t *model.Trip, u *model.User, lng, lat float64,
	takenAt *time.Time, info service.GeoInfo) (*model.Waypoint, bool, error) {
	var wps []model.Waypoint
	if err := tx.Where("trip_id = ?", t.ID).Order("seq, id").Find(&wps).Error; err != nil {
		return nil, false, err
	}
	if near := nearestWaypoint(wps, lng, lat, autoWaypointRadius); near != nil {
		wp := *near
		// A photo taken at a planned stop during the trip proves the visit.
		if wp.Planned && wp.Status == model.WPTodo && takenAt != nil && t.Phase != model.PhasePlanning {
			if err := markVisited(tx, &wp, *takenAt, true); err != nil {
				return nil, false, err
			}
		}
		return &wp, false, nil
	}
	if !info.Found && info.District == "" {
		info = h.svc.Locate(ctx, lng, lat, false)
	}
	wp := model.Waypoint{
		TripID: t.ID, Planned: false, Status: model.WPVisited, ArrivedAt: takenAt,
		Name: info.AutoName(), AutoNamed: true, Province: info.Province, ProvinceCode: info.ProvinceCode,
		City: info.City, CityCode: info.CityCode, District: info.District, Address: service.Truncate(info.Address, 200),
		Lng: lng, Lat: lat, Category: "other", Day: service.DayOfTrip(t.StartDate, takenAt, h.loc), CreatedByID: u.ID,
	}
	if err := service.InsertWaypoint(tx, &wp, service.ChronoInsertSeq(wps, takenAt)); err != nil {
		return nil, false, err
	}
	if err := h.svc.AwardExp(tx, u.ID, service.ExpKey("waypoint", wp.ID), service.ExpWaypoint, "waypoint"); err != nil {
		return nil, false, err
	}
	return &wp, true, nil
}

// photoForEdit loads the :id photo and requires trip membership.
func (h *Handler) photoForEdit(c *gin.Context) (*model.Photo, *model.Trip, error) {
	id, err := idParam(c, "id")
	if err != nil {
		return nil, nil, err
	}
	var p model.Photo
	if err := h.db.WithContext(c.Request.Context()).Limit(1).Find(&p, id).Error; err != nil {
		return nil, nil, err
	}
	if p.ID == 0 {
		return nil, nil, errNotFound("照片不存在")
	}
	t, a, err := h.loadTrip(c, p.TripID, "")
	if err != nil {
		if _, ok := err.(*apiError); ok {
			return nil, nil, errNotFound("照片不存在")
		}
		return nil, nil, err
	}
	if !a.CanEdit() {
		return nil, nil, errNotMember
	}
	return &p, t, nil
}

func (h *Handler) waypointPlace(tx *gorm.DB, wpID *int64) []int64 {
	if wpID == nil {
		return nil
	}
	var wp model.Waypoint
	tx.Select("id", "place_id").Limit(1).Find(&wp, *wpID)
	return service.PlaceIDs(wp.PlaceID)
}

func (h *Handler) updatePhoto(c *gin.Context) error {
	p, t, err := h.photoForEdit(c)
	if err != nil {
		return err
	}
	var req struct {
		Caption    *string `json:"caption"`
		WaypointID *int64  `json:"waypoint_id"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	db := h.db.WithContext(c.Request.Context())
	upd := map[string]any{}
	if req.Caption != nil {
		s, err := clean(*req.Caption, "说明", 500, false)
		if err != nil {
			return err
		}
		upd["caption"], p.Caption = s, s
	}
	oldWP := p.WaypointID
	if req.WaypointID != nil {
		if *req.WaypointID == 0 {
			upd["waypoint_id"], p.WaypointID = nil, nil
		} else {
			var n int64
			if err := db.Model(&model.Waypoint{}).Where("id = ? AND trip_id = ?", *req.WaypointID, t.ID).Count(&n).Error; err != nil {
				return err
			}
			if n == 0 {
				return errBad("打卡点不属于该旅程")
			}
			id := *req.WaypointID
			upd["waypoint_id"], p.WaypointID = id, &id
		}
	}
	if len(upd) > 0 {
		err := db.Transaction(func(tx *gorm.DB) error {
			if err := tx.Model(&model.Photo{}).Where("id = ?", p.ID).Updates(upd).Error; err != nil {
				return err
			}
			if req.WaypointID == nil {
				return nil
			}
			return h.svc.RecomputePlaces(tx, append(h.waypointPlace(tx, oldWP), h.waypointPlace(tx, p.WaypointID)...))
		})
		if err != nil {
			return err
		}
	}
	c.JSON(http.StatusOK, h.photoDTO(p))
	return nil
}

func (h *Handler) deletePhoto(c *gin.Context) error {
	p, t, err := h.photoForEdit(c)
	if err != nil {
		return err
	}
	err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		places := h.waypointPlace(tx, p.WaypointID)
		if err := tx.Delete(&model.Photo{}, p.ID).Error; err != nil {
			return err
		}
		if err := tx.Exec("UPDATE users SET storage_used = GREATEST(storage_used - ?, 0) WHERE id = ?", p.Size, p.UserID).Error; err != nil {
			return err
		}
		url := media.URL(p.Path)
		if t.CoverURL == url || t.CoverURL == media.URL(p.ThumbPath) {
			if err := tx.Model(&model.Trip{}).Where("id = ?", t.ID).Update("cover_url", "").Error; err != nil {
				return err
			}
		}
		if err := h.svc.RecomputeTrip(tx, t.ID); err != nil {
			return err
		}
		return h.svc.RecomputePlaces(tx, places)
	})
	if err != nil {
		return err
	}
	h.svc.Media.Remove(p.Path, p.ThumbPath)
	c.JSON(http.StatusOK, gin.H{})
	return nil
}

func (h *Handler) uploadImage(c *gin.Context) error {
	data, err := h.readUpload(c)
	if err != nil {
		return err
	}
	u := currentUser(c)
	if err := checkQuota(u, int64(len(data))); err != nil {
		return err
	}
	saved, err := h.svc.Media.SaveImage(data)
	if err != nil {
		return mediaError(err)
	}
	if err := chargeStorage(h.db.WithContext(c.Request.Context()), u, saved.Size); err != nil {
		h.svc.Media.Remove(saved.Path, saved.ThumbPath)
		return err
	}
	c.JSON(http.StatusOK, gin.H{"url": media.URL(saved.Path), "thumb_url": media.URL(saved.ThumbPath),
		"width": saved.Width, "height": saved.Height})
	return nil
}
