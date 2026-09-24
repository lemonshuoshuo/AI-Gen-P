package handler

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"triphub/internal/model"
	"triphub/internal/service"
)

func (h *Handler) adminStats(c *gin.Context) error {
	db := h.db.WithContext(c.Request.Context())
	var s struct {
		Users        int64 `json:"users"`
		Trips        int64 `json:"trips"`
		PublicTrips  int64 `json:"public_trips"`
		Places       int64 `json:"places"`
		Photos       int64 `json:"photos"`
		Comments     int64 `json:"comments"`
		StorageBytes int64 `json:"storage_bytes"`
	}
	db.Model(&model.User{}).Count(&s.Users)
	db.Model(&model.Trip{}).Count(&s.Trips)
	db.Model(&model.Trip{}).Where("visibility = ? AND status = ?", model.VisPublic, model.TripNormal).Count(&s.PublicTrips)
	db.Model(&model.Place{}).Where("checkin_count > 0").Count(&s.Places)
	db.Model(&model.Photo{}).Count(&s.Photos)
	db.Model(&model.Comment{}).Where("NOT deleted").Count(&s.Comments)
	db.Model(&model.User{}).Select("COALESCE(SUM(storage_used), 0)").Scan(&s.StorageBytes)

	now := time.Now().In(h.loc)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, h.loc)
	since := today.AddDate(0, 0, -13)
	type dayCount struct {
		D string
		N int64
	}
	series := map[string]map[string]int64{}
	for _, table := range []string{"users", "trips", "comments"} {
		var rows []dayCount
		q := "SELECT to_char(created_at AT TIME ZONE ?, 'YYYY-MM-DD') AS d, COUNT(*) AS n FROM " + table + " WHERE created_at >= ?"
		if table == "comments" {
			q += " AND NOT deleted"
		}
		q += " GROUP BY d"
		if err := db.Raw(q, h.loc.String(), since).Scan(&rows).Error; err != nil {
			return err
		}
		series[table] = map[string]int64{}
		for _, r := range rows {
			series[table][r.D] = r.N
		}
	}
	type trendDay struct {
		Date     string `json:"date"`
		Users    int64  `json:"users"`
		Trips    int64  `json:"trips"`
		Comments int64  `json:"comments"`
	}
	trend := make([]trendDay, 0, 14)
	for d := since; !d.After(today); d = d.AddDate(0, 0, 1) {
		k := d.Format("2006-01-02")
		trend = append(trend, trendDay{Date: k, Users: series["users"][k], Trips: series["trips"][k], Comments: series["comments"][k]})
	}
	last := trend[len(trend)-1]
	c.JSON(http.StatusOK, gin.H{
		"users": s.Users, "trips": s.Trips, "public_trips": s.PublicTrips, "places": s.Places,
		"photos": s.Photos, "comments": s.Comments, "storage_bytes": s.StorageBytes,
		"today": gin.H{"users": last.Users, "trips": last.Trips, "comments": last.Comments},
		"trend": trend,
	})
	return nil
}

type adminUserDTO struct {
	MeDTO
	TripCount   int64   `json:"trip_count"`
	LastLoginAt *string `json:"last_login_at"`
}

func (h *Handler) adminUserDTOs(ctx context.Context, users []model.User) ([]adminUserDTO, error) {
	out := make([]adminUserDTO, 0, len(users))
	if len(users) == 0 {
		return out, nil
	}
	db := h.db.WithContext(ctx)
	ids := make([]int64, len(users))
	for i, u := range users {
		ids[i] = u.ID
	}
	var counts []struct {
		OwnerID int64
		N       int64
	}
	if err := db.Model(&model.Trip{}).Select("owner_id, COUNT(*) AS n").Where("owner_id IN ?", ids).Group("owner_id").Scan(&counts).Error; err != nil {
		return nil, err
	}
	tripCount := map[int64]int64{}
	for _, r := range counts {
		tripCount[r.OwnerID] = r.N
	}
	var parts []model.Partnership
	if err := db.Where("user_a IN ? OR user_b IN ?", ids, ids).Find(&parts).Error; err != nil {
		return nil, err
	}
	partnerOf := map[int64]int64{}
	var pids []int64
	for _, p := range parts {
		partnerOf[p.UserA], partnerOf[p.UserB] = p.UserB, p.UserA
		pids = append(pids, p.UserA, p.UserB)
	}
	partners, err := h.loadUsers(ctx, pids)
	if err != nil {
		return nil, err
	}
	for i := range users {
		u := &users[i]
		out = append(out, adminUserDTO{MeDTO: *h.meFrom(u, partners[partnerOf[u.ID]]), TripCount: tripCount[u.ID], LastLoginAt: h.tsp(u.LastLoginAt)})
	}
	return out, nil
}

func (h *Handler) adminUsers(c *gin.Context) error {
	q := h.db.WithContext(c.Request.Context()).Model(&model.User{})
	if kw := strings.TrimSpace(c.Query("q")); kw != "" {
		like := escapeLike(kw)
		q = q.Where("(username ILIKE ? OR nickname ILIKE ? OR email ILIKE ?)", like, like, like)
	}
	if r := c.Query("role"); r != "" {
		q = q.Where("role = ?", r)
	}
	if s := c.Query("status"); s != "" {
		q = q.Where("status = ?", s)
	}
	p := pageParams(c)
	var users []model.User
	total, err := paginate(q, p, "id DESC", &users)
	if err != nil {
		return err
	}
	items, err := h.adminUserDTOs(c.Request.Context(), users)
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, newPage(items, total, p))
	return nil
}

func (h *Handler) adminUpdateUser(c *gin.Context) error {
	id, err := idParam(c, "id")
	if err != nil {
		return err
	}
	var req struct {
		Role   *string `json:"role"`
		Status *string `json:"status"`
		Exp    *int    `json:"exp"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	me := currentUser(c)
	db := h.db.WithContext(c.Request.Context())
	var u model.User
	if err := db.Limit(1).Find(&u, id).Error; err != nil {
		return err
	}
	if u.ID == 0 {
		return errNotFound("用户不存在")
	}
	upd := map[string]any{}
	if req.Role != nil {
		if *req.Role != model.RoleUser && *req.Role != model.RoleAdmin {
			return errBad("role 只能是 user / admin")
		}
		if u.ID == me.ID && *req.Role != model.RoleAdmin {
			return errBad("不能取消自己的管理员权限")
		}
		upd["role"] = *req.Role
	}
	if req.Status != nil {
		if *req.Status != model.UserActive && *req.Status != model.UserBanned {
			return errBad("status 只能是 active / banned")
		}
		if u.ID == me.ID && *req.Status == model.UserBanned {
			return errBad("不能封禁自己")
		}
		upd["status"] = *req.Status
	}
	if req.Exp != nil {
		if *req.Exp < 0 || *req.Exp > 10_000_000 {
			return errBad("经验值无效")
		}
		upd["exp"] = *req.Exp
	}
	if len(upd) > 0 {
		err := db.Transaction(func(tx *gorm.DB) error {
			if err := tx.Model(&u).Updates(upd).Error; err != nil {
				return err
			}
			if req.Status != nil && *req.Status == model.UserBanned {
				return tx.Where("user_id = ?", u.ID).Delete(&model.RefreshToken{}).Error
			}
			return nil
		})
		if err != nil {
			return err
		}
		if err := db.First(&u, u.ID).Error; err != nil {
			return err
		}
	}
	items, err := h.adminUserDTOs(c.Request.Context(), []model.User{u})
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, items[0])
	return nil
}

func (h *Handler) adminTrips(c *gin.Context) error {
	q := h.db.WithContext(c.Request.Context()).Model(&model.Trip{})
	if kw := strings.TrimSpace(c.Query("q")); kw != "" {
		like := escapeLike(kw)
		q = q.Where("(title ILIKE ? OR summary ILIKE ?)", like, like)
	}
	if s := c.Query("status"); s != "" {
		q = q.Where("status = ?", s)
	}
	if v := c.Query("visibility"); v != "" {
		q = q.Where("visibility = ?", v)
	}
	if c.Query("featured") == "true" {
		q = q.Where("featured")
	}
	return h.respondTripPage(c, q, "created_at DESC, id DESC")
}

func (h *Handler) adminUpdateTrip(c *gin.Context) error {
	id, err := idParam(c, "id")
	if err != nil {
		return err
	}
	var req struct {
		Featured *bool   `json:"featured"`
		Status   *string `json:"status"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	ctx := c.Request.Context()
	db := h.db.WithContext(ctx)
	var t model.Trip
	if err := db.Limit(1).Find(&t, id).Error; err != nil {
		return err
	}
	if t.ID == 0 {
		return errTripNotFound
	}
	if req.Status != nil && *req.Status != model.TripNormal && *req.Status != model.TripHidden {
		return errBad("status 只能是 normal / hidden")
	}
	err = db.Transaction(func(tx *gorm.DB) error {
		upd := map[string]any{}
		if req.Featured != nil && *req.Featured != t.Featured {
			upd["featured"] = *req.Featured
			if *req.Featured {
				upd["featured_at"] = time.Now()
				if err := h.svc.Notify(tx, service.Notice{UserID: t.OwnerID, Type: "featured", TripID: t.ID,
					Content: "你的旅程「" + t.Title + "」被设为精选"}); err != nil {
					return err
				}
				if err := h.svc.AwardExp(tx, t.OwnerID, service.ExpKey("featured", t.ID), service.ExpFeatured, "featured"); err != nil {
					return err
				}
			} else {
				upd["featured_at"] = nil
			}
		}
		statusChanged := req.Status != nil && *req.Status != t.Status
		if statusChanged {
			upd["status"] = *req.Status
		}
		if len(upd) == 0 {
			return nil
		}
		if err := tx.Model(&model.Trip{}).Where("id = ?", t.ID).UpdateColumns(upd).Error; err != nil {
			return err
		}
		if statusChanged {
			ids, err := service.TripPlaceIDs(tx, t.ID)
			if err != nil {
				return err
			}
			return h.svc.RecomputePlaces(tx, ids)
		}
		return nil
	})
	if err != nil {
		return err
	}
	if err := db.First(&t, t.ID).Error; err != nil {
		return err
	}
	card, err := h.tripCard(ctx, &t)
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, card)
	return nil
}

func (h *Handler) adminDeleteTrip(c *gin.Context) error {
	id, err := idParam(c, "id")
	if err != nil {
		return err
	}
	var n int64
	if err := h.db.WithContext(c.Request.Context()).Model(&model.Trip{}).Where("id = ?", id).Count(&n).Error; err != nil {
		return err
	}
	if n == 0 {
		return errTripNotFound
	}
	if err := h.svc.DeleteTrip(c.Request.Context(), id); err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{})
	return nil
}

func (h *Handler) adminComments(c *gin.Context) error {
	ctx := c.Request.Context()
	db := h.db.WithContext(ctx)
	q := db.Model(&model.Comment{}).Where("NOT deleted")
	if kw := strings.TrimSpace(c.Query("q")); kw != "" {
		q = q.Where("content ILIKE ?", escapeLike(kw))
	}
	p := pageParams(c)
	var cs []model.Comment
	total, err := paginate(q, p, "id DESC", &cs)
	if err != nil {
		return err
	}
	items, err := h.commentDTOs(ctx, cs, false, currentUser(c), 0)
	if err != nil {
		return err
	}
	var tripIDs, placeIDs []int64
	for _, cm := range cs {
		if cm.TripID != nil {
			tripIDs = append(tripIDs, *cm.TripID)
		}
		if cm.PlaceID != nil {
			placeIDs = append(placeIDs, *cm.PlaceID)
		}
	}
	trips := map[int64]string{}
	places := map[int64]string{}
	if len(tripIDs) > 0 {
		var ts []model.Trip
		db.Select("id", "title").Where("id IN ?", uniq(tripIDs)).Find(&ts)
		for _, t := range ts {
			trips[t.ID] = t.Title
		}
	}
	if len(placeIDs) > 0 {
		var ps []model.Place
		db.Select("id", "name").Where("id IN ?", uniq(placeIDs)).Find(&ps)
		for _, pl := range ps {
			places[pl.ID] = pl.Name
		}
	}
	for i := range items {
		if id := items[i].TripID; id != nil {
			items[i].Trip = &TripRef{ID: *id, Title: trips[*id]}
		}
		if id := items[i].PlaceID; id != nil {
			items[i].Place = &PlaceRef{ID: *id, Name: places[*id]}
		}
	}
	c.JSON(http.StatusOK, newPage(items, total, p))
	return nil
}

func (h *Handler) adminDeleteComment(c *gin.Context) error {
	cm, err := h.findComment(c)
	if err != nil {
		return err
	}
	if err := h.softDeleteComment(c, cm); err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{})
	return nil
}

type reportDTO struct {
	ID            int64      `json:"id"`
	Reporter      *UserBrief `json:"reporter"`
	TargetType    string     `json:"target_type"`
	TargetID      int64      `json:"target_id"`
	TargetPreview string     `json:"target_preview"`
	Reason        string     `json:"reason"`
	Status        string     `json:"status"`
	Note          string     `json:"note"`
	CreatedAt     string     `json:"created_at"`
	HandledAt     *string    `json:"handled_at"`
}

func (h *Handler) reportDTOs(ctx context.Context, rs []model.Report) ([]reportDTO, error) {
	db := h.db.WithContext(ctx)
	var uids []int64
	byType := map[string][]int64{}
	for _, r := range rs {
		uids = append(uids, r.ReporterID)
		byType[r.TargetType] = append(byType[r.TargetType], r.TargetID)
		if r.TargetType == "user" {
			uids = append(uids, r.TargetID)
		}
	}
	users, err := h.loadUsers(ctx, uids)
	if err != nil {
		return nil, err
	}
	preview := map[string]string{}
	key := func(t string, id int64) string { return t + ":" + service.ExpKey("", id) }
	if ids := byType["trip"]; len(ids) > 0 {
		var ts []model.Trip
		db.Select("id", "title").Where("id IN ?", uniq(ids)).Find(&ts)
		for _, t := range ts {
			preview[key("trip", t.ID)] = t.Title
		}
	}
	if ids := byType["comment"]; len(ids) > 0 {
		var cs []model.Comment
		db.Select("id", "content", "deleted").Where("id IN ?", uniq(ids)).Find(&cs)
		for _, cm := range cs {
			v := service.Truncate(cm.Content, 100)
			if cm.Deleted {
				v = "（已删除）"
			}
			preview[key("comment", cm.ID)] = v
		}
	}
	if ids := byType["place"]; len(ids) > 0 {
		var ps []model.Place
		db.Select("id", "name").Where("id IN ?", uniq(ids)).Find(&ps)
		for _, p := range ps {
			preview[key("place", p.ID)] = p.Name
		}
	}
	out := make([]reportDTO, 0, len(rs))
	for _, r := range rs {
		pv := preview[key(r.TargetType, r.TargetID)]
		if r.TargetType == "user" {
			if u := users[r.TargetID]; u != nil {
				pv = userBrief(u).Nickname + " (@" + u.Username + ")"
			}
		}
		if pv == "" {
			pv = "（已删除）"
		}
		out = append(out, reportDTO{ID: r.ID, Reporter: userBrief(users[r.ReporterID]), TargetType: r.TargetType,
			TargetID: r.TargetID, TargetPreview: pv, Reason: r.Reason, Status: r.Status, Note: r.Note,
			CreatedAt: h.ts(r.CreatedAt), HandledAt: h.tsp(r.HandledAt)})
	}
	return out, nil
}

func (h *Handler) adminReports(c *gin.Context) error {
	q := h.db.WithContext(c.Request.Context()).Model(&model.Report{})
	if s := c.Query("status"); s != "" {
		q = q.Where("status = ?", s)
	}
	p := pageParams(c)
	var rs []model.Report
	total, err := paginate(q, p, "id DESC", &rs)
	if err != nil {
		return err
	}
	items, err := h.reportDTOs(c.Request.Context(), rs)
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, newPage(items, total, p))
	return nil
}

func (h *Handler) adminUpdateReport(c *gin.Context) error {
	id, err := idParam(c, "id")
	if err != nil {
		return err
	}
	var req struct {
		Status string  `json:"status"`
		Note   *string `json:"note"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	if req.Status != model.ReportPending && req.Status != model.ReportResolved && req.Status != model.ReportRejected {
		return errBad("status 只能是 pending / resolved / rejected")
	}
	db := h.db.WithContext(c.Request.Context())
	var r model.Report
	if err := db.Limit(1).Find(&r, id).Error; err != nil {
		return err
	}
	if r.ID == 0 {
		return errNotFound("举报不存在")
	}
	upd := map[string]any{"status": req.Status}
	if req.Note != nil {
		note, err := clean(*req.Note, "处理备注", 500, false)
		if err != nil {
			return err
		}
		upd["note"] = note
	}
	if req.Status == model.ReportPending {
		upd["handled_at"], upd["handled_by_id"] = nil, nil
	} else {
		upd["handled_at"], upd["handled_by_id"] = time.Now(), currentUserID(c)
	}
	if err := db.Model(&r).Updates(upd).Error; err != nil {
		return err
	}
	if err := db.First(&r, r.ID).Error; err != nil {
		return err
	}
	items, err := h.reportDTOs(c.Request.Context(), []model.Report{r})
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, items[0])
	return nil
}

func (h *Handler) adminGetSettings(c *gin.Context) error {
	c.JSON(http.StatusOK, h.svc.Settings.Get())
	return nil
}

func (h *Handler) adminPutSettings(c *gin.Context) error {
	cur := h.svc.Settings.Get()
	var req struct {
		SiteName         *string `json:"site_name"`
		Announcement     *string `json:"announcement"`
		RegistrationOpen *bool   `json:"registration_open"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	if req.SiteName != nil {
		v, err := clean(*req.SiteName, "站点名称", 30, true)
		if err != nil {
			return err
		}
		cur.SiteName = v
	}
	if req.Announcement != nil {
		v, err := clean(*req.Announcement, "公告", 500, false)
		if err != nil {
			return err
		}
		cur.Announcement = v
	}
	if req.RegistrationOpen != nil {
		cur.RegistrationOpen = *req.RegistrationOpen
	}
	if err := h.svc.Settings.Save(cur); err != nil {
		return err
	}
	c.JSON(http.StatusOK, cur)
	return nil
}
