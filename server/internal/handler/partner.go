package handler

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"triphub/internal/model"
	"triphub/internal/service"
)

func (h *Handler) partnerState(c *gin.Context) (gin.H, error) {
	ctx := c.Request.Context()
	db := h.db.WithContext(ctx)
	u := currentUser(c)
	partnerID, p, err := service.PartnerOf(db, u.ID)
	if err != nil {
		return nil, err
	}
	var incoming, outgoing []model.PartnerInvite
	if err := db.Where("to_id = ? AND status = ?", u.ID, model.InvitePending).Order("created_at DESC").Find(&incoming).Error; err != nil {
		return nil, err
	}
	if err := db.Where("from_id = ? AND status = ?", u.ID, model.InvitePending).Order("created_at DESC").Find(&outgoing).Error; err != nil {
		return nil, err
	}
	in, err := h.partnerInviteDTOs(ctx, incoming)
	if err != nil {
		return nil, err
	}
	out, err := h.partnerInviteDTOs(ctx, outgoing)
	if err != nil {
		return nil, err
	}
	res := gin.H{"partner": nil, "since": nil, "title": "", "bound_at": nil, "public": false,
		"invites": gin.H{"incoming": in, "outgoing": out}}
	if p != nil {
		users, err := h.loadUsers(ctx, []int64{partnerID})
		if err != nil {
			return nil, err
		}
		res["partner"] = userBrief(users[partnerID])
		res["since"] = service.FormatDate(p.Since)
		res["title"] = p.Title
		res["bound_at"] = h.ts(p.BoundAt)
		res["public"] = p.Public
	}
	return res, nil
}

func (h *Handler) getPartner(c *gin.Context) error {
	res, err := h.partnerState(c)
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, res)
	return nil
}

func (h *Handler) updatePartner(c *gin.Context) error {
	var req struct {
		Since  Opt[string] `json:"since"`
		Title  *string     `json:"title"`
		Public *bool       `json:"public"` // show the relationship on both profiles
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	db := h.db.WithContext(c.Request.Context())
	_, p, err := service.PartnerOf(db, currentUserID(c))
	if err != nil {
		return err
	}
	if p == nil {
		return errBad("尚未绑定情侣")
	}
	upd := map[string]any{}
	if req.Since.Set {
		d, err := parseDate(req.Since.V, "since")
		if err != nil {
			return err
		}
		// parseDate gives UTC midnight: compare with today's date in Beijing time.
		if d != nil && d.After(service.DateOnly(time.Now(), h.loc)) {
			return errBad("纪念日不能晚于今天")
		}
		upd["since"] = d
	}
	if req.Title != nil {
		t, err := clean(*req.Title, "空间名称", 30, false)
		if err != nil {
			return err
		}
		if err := h.screen(c, t); err != nil {
			return err
		}
		upd["title"] = t
	}
	if req.Public != nil {
		upd["public"] = *req.Public
	}
	if len(upd) > 0 {
		if err := db.Model(p).Updates(upd).Error; err != nil {
			return err
		}
	}
	return h.getPartner(c)
}

// unbindPartner ends the couple binding. Shared trips are kept, and with
// ?remove_shared_access=true each one also stops being a co-author (or
// invitee) of the trips the other owns; otherwise both keep full access to
// them until removed in the trip's members.
func (h *Handler) unbindPartner(c *gin.Context) error {
	u := currentUser(c)
	removeShared := queryBool(c, "remove_shared_access")
	err := h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		partnerID, p, err := service.PartnerOf(tx, u.ID)
		if err != nil {
			return err
		}
		if p == nil {
			return errBad("尚未绑定情侣")
		}
		if err := tx.Delete(p).Error; err != nil {
			return err
		}
		// Memberships of one in trips the other owns.
		coAuthor := func(owner, member int64) *gorm.DB {
			return tx.Model(&model.TripMember{}).Where("user_id = ? AND role <> ? AND trip_id IN (?)", member, model.MemberOwner,
				tx.Model(&model.Trip{}).Select("id").Where("owner_id = ?", owner))
		}
		var shared int64
		for _, om := range [][2]int64{{u.ID, partnerID}, {partnerID, u.ID}} {
			var n int64
			if err := coAuthor(om[0], om[1]).Count(&n).Error; err != nil {
				return err
			}
			shared += n
			if removeShared && n > 0 {
				if err := coAuthor(om[0], om[1]).Delete(&model.TripMember{}).Error; err != nil {
					return err
				}
			}
		}
		content := userBrief(u).Nickname + " 解除了情侣绑定"
		switch {
		case shared > 0 && removeShared:
			content += "，并结束了你们在彼此旅程中的共同作者关系"
		case shared > 0:
			content += "（你们仍是共同旅程的共同作者，可在旅程「成员」中移除）"
		}
		return h.svc.Notify(tx, service.Notice{UserID: partnerID, Type: "system", ActorID: u.ID, Content: content})
	})
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{})
	return nil
}

func (h *Handler) createPartnerInvite(c *gin.Context) error {
	var req struct {
		Username string `json:"username"`
		Message  string `json:"message"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	msg, err := clean(req.Message, "留言", 200, false)
	if err != nil {
		return err
	}
	if err := h.screen(c, msg); err != nil {
		return err
	}
	name := strings.TrimPrefix(strings.TrimSpace(req.Username), "@")
	if name == "" {
		return errBad("请输入对方的用户名")
	}
	u := currentUser(c)
	var inv model.PartnerInvite
	err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		var target model.User
		if err := tx.Where("lower(username) = lower(?)", name).Limit(1).Find(&target).Error; err != nil {
			return err
		}
		if target.ID == 0 || target.Status == model.UserDeleted {
			return errNotFound("用户不存在")
		}
		if target.ID == u.ID {
			return errBad("不能邀请自己")
		}
		if target.Status == model.UserBanned {
			return errBad("该用户无法被邀请")
		}
		if pid, _, err := service.PartnerOf(tx, u.ID); err != nil {
			return err
		} else if pid != 0 {
			return errConflict("你已绑定情侣，请先解除绑定")
		}
		if pid, _, err := service.PartnerOf(tx, target.ID); err != nil {
			return err
		} else if pid != 0 {
			return errConflict("对方已绑定情侣")
		}
		var n int64
		if err := tx.Model(&model.PartnerInvite{}).Where("from_id = ? AND to_id = ? AND status = ?", target.ID, u.ID, model.InvitePending).
			Count(&n).Error; err != nil {
			return err
		}
		if n > 0 {
			return errConflict("对方已向你发出邀请，请直接接受")
		}
		if err := tx.Model(&model.PartnerInvite{}).Where("from_id = ? AND to_id = ? AND status = ?", u.ID, target.ID, model.InvitePending).
			Count(&n).Error; err != nil {
			return err
		}
		if n > 0 {
			return errConflict("已发送过邀请，请等待对方回应")
		}
		inv = model.PartnerInvite{FromID: u.ID, ToID: target.ID, Message: msg, Status: model.InvitePending}
		if err := tx.Create(&inv).Error; err != nil {
			return err
		}
		content := "邀请你一起记录「我们一起走过的地方」"
		if msg != "" {
			content = msg
		}
		return h.svc.Notify(tx, service.Notice{UserID: target.ID, Type: "partner_invite", ActorID: u.ID, Content: content})
	})
	if err != nil {
		return err
	}
	dtos, err := h.partnerInviteDTOs(c.Request.Context(), []model.PartnerInvite{inv})
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, dtos[0])
	return nil
}

func (h *Handler) findInvite(c *gin.Context, tx *gorm.DB, incoming bool) (*model.PartnerInvite, error) {
	id, err := idParam(c, "id")
	if err != nil {
		return nil, err
	}
	col := "from_id"
	if incoming {
		col = "to_id"
	}
	var inv model.PartnerInvite
	if err := tx.Where("id = ? AND "+col+" = ? AND status = ?", id, currentUserID(c), model.InvitePending).Limit(1).Find(&inv).Error; err != nil {
		return nil, err
	}
	if inv.ID == 0 {
		return nil, errNotFound("邀请不存在或已处理")
	}
	return &inv, nil
}

func (h *Handler) acceptPartnerInvite(c *gin.Context) error {
	err := h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		inv, err := h.findInvite(c, tx, true)
		if err != nil {
			return err
		}
		a, b := inv.FromID, inv.ToID
		if a > b {
			a, b = b, a
		}
		// Lock both users in a fixed order so concurrent accepts serialise.
		if err := tx.Exec("SELECT id FROM users WHERE id IN (?, ?) ORDER BY id FOR UPDATE", a, b).Error; err != nil {
			return err
		}
		for _, uid := range []int64{a, b} {
			if pid, _, err := service.PartnerOf(tx, uid); err != nil {
				return err
			} else if pid != 0 {
				if uid == inv.ToID {
					return errConflict("你已绑定情侣，请先解除绑定")
				}
				return errConflict("对方已绑定情侣")
			}
		}
		if err := tx.Create(&model.Partnership{UserA: a, UserB: b, BoundAt: time.Now()}).Error; err != nil {
			return err
		}
		// Only a still-pending invite: it may have been withdrawn or declined
		// after findInvite read it (the rollback also drops the partnership).
		res := tx.Model(inv).Where("status = ?", model.InvitePending).Update("status", model.InviteAccepted)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return errNotFound("邀请不存在或已处理")
		}
		if err := tx.Model(&model.PartnerInvite{}).
			Where("status = ? AND id <> ? AND (from_id IN (?, ?) OR to_id IN (?, ?))", model.InvitePending, inv.ID, a, b, a, b).
			Update("status", model.InviteCanceled).Error; err != nil {
			return err
		}
		return h.svc.Notify(tx, service.Notice{UserID: inv.FromID, Type: "partner_accept", ActorID: inv.ToID,
			Content: "接受了你的情侣邀请"})
	})
	if err != nil {
		return err
	}
	return h.getPartner(c)
}

func (h *Handler) setInviteStatus(c *gin.Context, incoming bool, status string) error {
	db := h.db.WithContext(c.Request.Context())
	inv, err := h.findInvite(c, db, incoming)
	if err != nil {
		return err
	}
	// Conditional, so it cannot overwrite an invite accepted meanwhile.
	res := db.Model(inv).Where("status = ?", model.InvitePending).Update("status", status)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return errNotFound("邀请不存在或已处理")
	}
	c.JSON(http.StatusOK, gin.H{})
	return nil
}

func (h *Handler) declinePartnerInvite(c *gin.Context) error {
	return h.setInviteStatus(c, true, model.InviteDeclined)
}

func (h *Handler) cancelPartnerInvite(c *gin.Context) error {
	return h.setInviteStatus(c, false, model.InviteCanceled)
}

// sharedTripIDs selects trips where both users are accepted members.
func sharedTripIDs(db *gorm.DB, a, b int64) *gorm.DB {
	return db.Model(&model.TripMember{}).Select("trip_id").
		Where("user_id IN ? AND status = ?", []int64{a, b}, model.MemberAccepted).
		Group("trip_id").Having("COUNT(DISTINCT user_id) = 2")
}

func (h *Handler) partnerTrips(c *gin.Context) error {
	db := h.db.WithContext(c.Request.Context())
	u := currentUser(c)
	partnerID, _, err := service.PartnerOf(db, u.ID)
	if err != nil {
		return err
	}
	if partnerID == 0 {
		p := pageParams(c)
		c.JSON(http.StatusOK, newPage([]TripCard{}, 0, p))
		return nil
	}
	q := db.Model(&model.Trip{}).Where("id IN (?)", sharedTripIDs(db, u.ID, partnerID))
	return h.respondTripPage(c, q, "start_date DESC NULLS LAST, created_at DESC")
}

func (h *Handler) partnerFootprints(c *gin.Context) error {
	db := h.db.WithContext(c.Request.Context())
	u := currentUser(c)
	partnerID, _, err := service.PartnerOf(db, u.ID)
	if err != nil {
		return err
	}
	if partnerID == 0 {
		c.JSON(http.StatusOK, service.EmptyFootprints())
		return nil
	}
	fp, err := h.svc.BuildFootprints(db, sharedTripIDs(db, u.ID, partnerID))
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, fp)
	return nil
}
