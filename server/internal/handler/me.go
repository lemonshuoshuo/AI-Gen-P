package handler

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"triphub/internal/auth"
	"triphub/internal/media"
	"triphub/internal/model"
	"triphub/internal/service"
)

func (h *Handler) getMe(c *gin.Context) error {
	me, err := h.meDTO(c.Request.Context(), currentUser(c))
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, me)
	return nil
}

func (h *Handler) updateMe(c *gin.Context) error {
	var req struct {
		Nickname  *string `json:"nickname"`
		Bio       *string `json:"bio"`
		AvatarURL *string `json:"avatar_url"`
		Email     *string `json:"email"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	u := currentUser(c)
	db := h.db.WithContext(c.Request.Context())
	upd := map[string]any{}
	if req.Nickname != nil {
		v, err := clean(*req.Nickname, "昵称", 20, true)
		if err != nil {
			return err
		}
		if err := h.screen(c, v); err != nil {
			return err
		}
		upd["nickname"] = v
	}
	if req.Bio != nil {
		v, err := clean(*req.Bio, "个人简介", 200, false)
		if err != nil {
			return err
		}
		if err := h.screen(c, v); err != nil {
			return err
		}
		upd["bio"] = v
	}
	if req.AvatarURL != nil {
		v, err := validURL(*req.AvatarURL, "头像地址")
		if err != nil {
			return err
		}
		upd["avatar_url"] = v
	}
	if req.Email != nil {
		v, err := normalizeEmail(*req.Email)
		if err != nil {
			return err
		}
		if v != "" && !strings.EqualFold(v, u.Email) {
			var n int64
			if err := db.Model(&model.User{}).Where("lower(email) = lower(?) AND id <> ?", v, u.ID).Count(&n).Error; err != nil {
				return err
			}
			if n > 0 {
				return errConflict("邮箱已被其他账号使用")
			}
		}
		upd["email"] = v
	}
	if len(upd) > 0 {
		if err := db.Model(u).Updates(upd).Error; err != nil {
			if errors.Is(err, gorm.ErrDuplicatedKey) {
				return errConflict("邮箱已被其他账号使用")
			}
			return err
		}
		if err := db.First(u, u.ID).Error; err != nil {
			return err
		}
	}
	return h.getMe(c)
}

func (h *Handler) changePassword(c *gin.Context) error {
	var req struct {
		OldPassword  string `json:"old_password"`
		NewPassword  string `json:"new_password"`
		RefreshToken string `json:"refresh_token"` // optional: keep this session
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	u := currentUser(c)
	if !auth.CheckPassword(u.PasswordHash, req.OldPassword) {
		return errBad("原密码不正确")
	}
	if err := validatePassword(req.NewPassword); err != nil {
		return err
	}
	hash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		return err
	}
	err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(u).Update("password_hash", hash).Error; err != nil {
			return err
		}
		// Revoke every other session: keep the one this access token was
		// issued with (and/or the refresh token passed explicitly).
		q := tx.Where("user_id = ?", u.ID)
		if sid := c.GetInt64(ctxSession); sid != 0 {
			q = q.Where("id <> ?", sid)
		}
		if req.RefreshToken != "" {
			q = q.Where("token_hash <> ?", auth.HashToken(req.RefreshToken))
		}
		return q.Delete(&model.RefreshToken{}).Error
	})
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{})
	return nil
}

// deleteMe closes the current user's account (注销). Trips nobody else can
// edit are deleted; shared trips pass to their earliest co-author. The
// user's photos, GPS tracks, likes, favourites, follows, memberships,
// invites, notifications and couple binding are removed and their comments
// become "deleted" placeholders. The user row is kept anonymised so that
// comment threads and co-authored waypoints still resolve their author.
func (h *Handler) deleteMe(c *gin.Context) error {
	var req struct {
		Password string `json:"password"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	u := currentUser(c)
	if u.IsAdmin() {
		return errBad("管理员账号不能注销")
	}
	if !auth.CheckPassword(u.PasswordHash, req.Password) {
		return errBad("密码不正确")
	}
	ctx := c.Request.Context()
	db := h.db.WithContext(ctx)
	// successor is the earliest other accepted member of a trip (0 if none).
	successor := func(tx *gorm.DB, tripID int64) (int64, error) {
		var m model.TripMember
		err := tx.Where("trip_id = ? AND user_id <> ? AND status = ?", tripID, u.ID, model.MemberAccepted).
			Order("created_at, id").Limit(1).Find(&m).Error
		return m.UserID, err
	}
	var owned []int64
	if err := db.Model(&model.Trip{}).Where("owner_id = ?", u.ID).Pluck("id", &owned).Error; err != nil {
		return err
	}
	for _, id := range owned {
		next, err := successor(db, id)
		if err != nil {
			return err
		}
		if next == 0 {
			if err := h.svc.DeleteTrip(ctx, id); err != nil {
				return err
			}
		}
	}

	var files []string
	var orphans, trackTrips []int64
	err := db.Transaction(func(tx *gorm.DB) error {
		var shared []model.Trip
		if err := tx.Select("id", "title").Where("owner_id = ?", u.ID).Find(&shared).Error; err != nil {
			return err
		}
		for _, t := range shared {
			next, err := successor(tx, t.ID)
			if err != nil {
				return err
			}
			if next == 0 { // the co-author left in the meantime
				orphans = append(orphans, t.ID)
				continue
			}
			if err := tx.Model(&model.Trip{}).Where("id = ?", t.ID).Update("owner_id", next).Error; err != nil {
				return err
			}
			if err := tx.Model(&model.TripMember{}).Where("trip_id = ? AND user_id = ?", t.ID, next).Update("role", model.MemberOwner).Error; err != nil {
				return err
			}
			if err := h.svc.Notify(tx, service.Notice{UserID: next, Type: "system", TripID: t.ID,
				Content: "共同作者注销了账号，你已成为旅程「" + t.Title + "」的作者"}); err != nil {
				return err
			}
		}

		// Photos (files are removed after commit).
		var photos []model.Photo
		if err := tx.Where("user_id = ?", u.ID).Find(&photos).Error; err != nil {
			return err
		}
		touched := map[int64]bool{} // trips whose statistics change
		var urls []string
		var photoWPs, placeIDs []int64
		for _, p := range photos {
			files = append(files, p.Path, p.ThumbPath)
			urls = append(urls, media.URL(p.Path), media.URL(p.ThumbPath))
			touched[p.TripID] = true
			if p.WaypointID != nil {
				photoWPs = append(photoWPs, *p.WaypointID)
			}
		}
		if len(photos) > 0 {
			if err := tx.Where("user_id = ?", u.ID).Delete(&model.Photo{}).Error; err != nil {
				return err
			}
			if err := tx.Model(&model.Trip{}).Where("cover_url IN ?", urls).Update("cover_url", "").Error; err != nil {
				return err
			}
		}
		if len(photoWPs) > 0 {
			if err := tx.Model(&model.Waypoint{}).Where("id IN ? AND place_id IS NOT NULL", photoWPs).Pluck("place_id", &placeIDs).Error; err != nil {
				return err
			}
		}

		// GPS tracks.
		if err := tx.Model(&model.TrackPoint{}).Where("user_id = ?", u.ID).Distinct().Pluck("trip_id", &trackTrips).Error; err != nil {
			return err
		}
		if len(trackTrips) > 0 {
			// Lock the trips (in id order) against concurrent appends, which update the counters incrementally.
			if err := tx.Exec("SELECT id FROM trips WHERE id IN ? ORDER BY id FOR UPDATE", trackTrips).Error; err != nil {
				return err
			}
			if err := tx.Where("user_id = ?", u.ID).Delete(&model.TrackPoint{}).Error; err != nil {
				return err
			}
		}

		// Comments stay as placeholders (threads keep their replies).
		var cms []model.Comment
		if err := tx.Select("id", "trip_id", "place_id").Where("user_id = ? AND NOT deleted", u.ID).Find(&cms).Error; err != nil {
			return err
		}
		commentTrips := map[int64]bool{}
		for _, cm := range cms {
			if cm.TripID != nil {
				commentTrips[*cm.TripID] = true
			}
			if cm.PlaceID != nil {
				placeIDs = append(placeIDs, *cm.PlaceID)
			}
		}
		if len(cms) > 0 {
			if err := tx.Model(&model.Comment{}).Where("user_id = ?", u.ID).Updates(map[string]any{"deleted": true, "content": ""}).Error; err != nil {
				return err
			}
		}
		for id := range commentTrips {
			if err := h.recountTripComments(tx, id); err != nil {
				return err
			}
		}

		// Likes and favourites.
		for _, lf := range []struct{ table, counter string }{{"likes", "like_count"}, {"favorites", "fav_count"}} {
			var ids []int64
			if err := tx.Raw("DELETE FROM "+lf.table+" WHERE user_id = ? RETURNING trip_id", u.ID).Scan(&ids).Error; err != nil {
				return err
			}
			if len(ids) > 0 {
				if err := tx.Exec("UPDATE trips SET "+lf.counter+" = (SELECT COUNT(*) FROM "+lf.table+" x WHERE x.trip_id = trips.id) WHERE id IN ?",
					ids).Error; err != nil {
					return err
				}
			}
		}

		// Relations and personal records.
		for _, del := range []struct {
			q    string
			args []any
		}{
			{"DELETE FROM follows WHERE follower_id = ? OR followee_id = ?", []any{u.ID, u.ID}},
			{"DELETE FROM trip_members WHERE user_id = ?", []any{u.ID}},
			{"DELETE FROM partner_invites WHERE from_id = ? OR to_id = ?", []any{u.ID, u.ID}},
			{"DELETE FROM notifications WHERE user_id = ?", []any{u.ID}},
			{"DELETE FROM exp_logs WHERE user_id = ?", []any{u.ID}},
			{"DELETE FROM refresh_tokens WHERE user_id = ?", []any{u.ID}},
		} {
			if err := tx.Exec(del.q, del.args...).Error; err != nil {
				return err
			}
		}
		partnerID, p, err := service.PartnerOf(tx, u.ID)
		if err != nil {
			return err
		}
		if p != nil {
			if err := tx.Delete(p).Error; err != nil {
				return err
			}
			if err := h.svc.Notify(tx, service.Notice{UserID: partnerID, Type: "system", Content: "对方已注销账号，情侣绑定已解除"}); err != nil {
				return err
			}
		}

		// Refresh statistics.
		for _, id := range trackTrips {
			if err := h.svc.RecomputeTrack(tx, id); err != nil { // includes RecomputeTrip
				return err
			}
			delete(touched, id)
		}
		for id := range touched {
			if err := h.svc.RecomputeTrip(tx, id); err != nil {
				return err
			}
		}
		if err := h.svc.RecomputePlaces(tx, placeIDs); err != nil {
			return err
		}

		// Anonymise the account; the hyphen keeps the name from ever being registered.
		return tx.Model(&model.User{}).Where("id = ?", u.ID).Updates(map[string]any{
			"username": fmt.Sprintf("deleted-%d", u.ID), "email": "", "nickname": "已注销用户", "bio": "", "avatar_url": "",
			"password_hash": "", "role": model.RoleUser, "status": model.UserDeleted, "exp": 0, "storage_used": 0,
			"last_login_at": nil,
		}).Error
	})
	if err != nil {
		return err
	}
	for _, id := range orphans {
		if err := h.svc.DeleteTrip(ctx, id); err != nil {
			slog.Error("delete trip of closed account", "trip", id, "err", err)
		}
	}
	h.svc.Media.Remove(files...)
	if rel, ok := media.RelFromURL(u.AvatarURL); ok && strings.HasPrefix(rel, media.AvatarPrefix(u.ID)) {
		h.svc.Media.Remove(rel)
	}
	for _, id := range trackTrips {
		h.trackCache.dropTrip(id)
	}
	c.JSON(http.StatusOK, gin.H{})
	return nil
}

// readUpload reads the multipart "file" field into memory, enforcing the size limit.
func (h *Handler) readUpload(c *gin.Context) ([]byte, error) {
	fh, err := c.FormFile("file")
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return nil, errTooLarge(fmt.Sprintf("文件不能超过 %d MB", h.cfg.MaxUploadMB))
		}
		return nil, errBad("请选择要上传的图片（字段 file）")
	}
	if fh.Size > h.cfg.MaxUploadBytes() {
		return nil, errTooLarge(fmt.Sprintf("文件不能超过 %d MB", h.cfg.MaxUploadMB))
	}
	f, err := fh.Open()
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, h.cfg.MaxUploadBytes()+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > h.cfg.MaxUploadBytes() {
		return nil, errTooLarge(fmt.Sprintf("文件不能超过 %d MB", h.cfg.MaxUploadMB))
	}
	if len(data) == 0 {
		return nil, errBad("文件为空")
	}
	return data, nil
}

func mediaError(err error) error {
	switch {
	case errors.Is(err, media.ErrUnsupported):
		return errBad("不支持的图片格式，仅支持 jpg / png / webp / gif")
	case errors.Is(err, media.ErrTooLarge):
		return errBad("图片分辨率过大")
	}
	return err
}

func (h *Handler) uploadAvatar(c *gin.Context) error {
	data, err := h.readUpload(c)
	if err != nil {
		return err
	}
	u := currentUser(c)
	rel, err := h.svc.Media.SaveAvatar(data, u.ID)
	if err != nil {
		return mediaError(err)
	}
	old := u.AvatarURL
	url := media.URL(rel)
	if err := h.db.WithContext(c.Request.Context()).Model(u).Update("avatar_url", url).Error; err != nil {
		h.svc.Media.Remove(rel)
		return err
	}
	if oldRel, ok := media.RelFromURL(old); ok && strings.HasPrefix(oldRel, media.AvatarPrefix(u.ID)) {
		h.svc.Media.Remove(oldRel)
	}
	c.JSON(http.StatusOK, gin.H{"avatar_url": url})
	return nil
}

// respondTripPage paginates a trip query and responds with TripCards.
func (h *Handler) respondTripPage(c *gin.Context, q *gorm.DB, order string) error {
	p := pageParams(c)
	var trips []model.Trip
	total, err := paginate(q.Omit("content"), p, order, &trips)
	if err != nil {
		return err
	}
	if err := h.loadSummarySources(c.Request.Context(), trips); err != nil {
		return err
	}
	cards, err := h.tripCards(c.Request.Context(), trips)
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, newPage(cards, total, p))
	return nil
}

func validPhase(p string) bool {
	return p == model.PhasePlanning || p == model.PhaseOngoing || p == model.PhaseFinished
}

func validVisibility(v string) bool {
	return v == model.VisPrivate || v == model.VisUnlisted || v == model.VisPublic
}

func (h *Handler) myTrips(c *gin.Context) error {
	u := currentUser(c)
	db := h.db.WithContext(c.Request.Context())
	q := db.Model(&model.Trip{}).Where("id IN (?)", service.MemberTripIDs(db, u.ID))
	if p := c.Query("phase"); p != "" {
		if !validPhase(p) {
			return errBad("phase 参数无效")
		}
		q = q.Where("phase = ?", p)
	}
	if v := c.Query("visibility"); v != "" {
		if !validVisibility(v) {
			return errBad("visibility 参数无效")
		}
		q = q.Where("visibility = ?", v)
	}
	return h.respondTripPage(c, q, "updated_at DESC, id DESC")
}

func (h *Handler) myFavorites(c *gin.Context) error {
	u := currentUser(c)
	db := h.db.WithContext(c.Request.Context())
	p := pageParams(c)
	visible := db.Model(&model.Trip{}).Select("trips.id").
		Where("(trips.visibility = ? AND trips.status = ?) OR trips.id IN (?)", model.VisPublic, model.TripNormal, service.MemberTripIDs(db, u.ID))
	q := db.Model(&model.Trip{}).Joins("JOIN favorites f ON f.trip_id = trips.id AND f.user_id = ?", u.ID).
		Where("trips.id IN (?)", visible)
	var trips []model.Trip
	total, err := paginate(q.Omit("content"), p, "f.created_at DESC", &trips)
	if err != nil {
		return err
	}
	if err := h.loadSummarySources(c.Request.Context(), trips); err != nil {
		return err
	}
	cards, err := h.tripCards(c.Request.Context(), trips)
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, newPage(cards, total, p))
	return nil
}

func (h *Handler) myFootprints(c *gin.Context) error {
	u := currentUser(c)
	db := h.db.WithContext(c.Request.Context())
	fp, err := h.svc.BuildFootprints(db, service.MemberTripIDs(db, u.ID))
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, fp)
	return nil
}

func (h *Handler) myInvites(c *gin.Context) error {
	u := currentUser(c)
	ctx := c.Request.Context()
	db := h.db.WithContext(ctx)
	var pending []model.TripMember
	if err := db.Where("user_id = ? AND status = ?", u.ID, model.MemberPending).Order("created_at DESC").Find(&pending).Error; err != nil {
		return err
	}
	type tripInvite struct {
		Trip      TripCard   `json:"trip"`
		From      *UserBrief `json:"from"`
		CreatedAt string     `json:"created_at"`
	}
	tripInvites := []tripInvite{}
	if len(pending) > 0 {
		var ids, inviters []int64
		for _, m := range pending {
			ids = append(ids, m.TripID)
			inviters = append(inviters, m.InvitedByID)
		}
		var trips []model.Trip
		if err := db.Omit("content").Where("id IN ?", ids).Find(&trips).Error; err != nil {
			return err
		}
		if err := h.loadSummarySources(ctx, trips); err != nil {
			return err
		}
		cards, err := h.tripCards(ctx, trips)
		if err != nil {
			return err
		}
		byID := map[int64]TripCard{}
		for _, cd := range cards {
			byID[cd.ID] = cd
		}
		users, err := h.loadUsers(ctx, inviters)
		if err != nil {
			return err
		}
		for _, m := range pending {
			if cd, ok := byID[m.TripID]; ok {
				tripInvites = append(tripInvites, tripInvite{Trip: cd, From: userBrief(users[m.InvitedByID]), CreatedAt: h.ts(m.CreatedAt)})
			}
		}
	}
	var invs []model.PartnerInvite
	if err := db.Where("to_id = ? AND status = ?", u.ID, model.InvitePending).Order("created_at DESC").Find(&invs).Error; err != nil {
		return err
	}
	pinv, err := h.partnerInviteDTOs(ctx, invs)
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{"trip_invites": tripInvites, "partner_invites": pinv})
	return nil
}
