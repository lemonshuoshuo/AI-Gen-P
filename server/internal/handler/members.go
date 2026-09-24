package handler

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"triphub/internal/model"
	"triphub/internal/service"
)

const maxTripMembers = 20

type memberDTO struct {
	User   *UserBrief `json:"user"`
	Role   string     `json:"role"`
	Status string     `json:"status"`
}

func (h *Handler) memberList(c *gin.Context, tripID int64) ([]memberDTO, error) {
	var ms []model.TripMember
	if err := h.db.WithContext(c.Request.Context()).Where("trip_id = ?", tripID).
		Order("CASE WHEN role = 'owner' THEN 0 ELSE 1 END, created_at, id").Find(&ms).Error; err != nil {
		return nil, err
	}
	ids := make([]int64, len(ms))
	for i, m := range ms {
		ids[i] = m.UserID
	}
	users, err := h.loadUsers(c.Request.Context(), ids)
	if err != nil {
		return nil, err
	}
	out := make([]memberDTO, 0, len(ms))
	for _, m := range ms {
		if u := users[m.UserID]; u != nil {
			out = append(out, memberDTO{User: userBrief(u), Role: m.Role, Status: m.Status})
		}
	}
	return out, nil
}

func (h *Handler) listMembers(c *gin.Context) error {
	t, a, err := h.tripForView(c)
	if err != nil {
		return err
	}
	if !a.Member && !a.Admin {
		return errNotMember
	}
	list, err := h.memberList(c, t.ID)
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, list)
	return nil
}

func (h *Handler) inviteMember(c *gin.Context) error {
	t, _, err := h.tripForOwner(c)
	if err != nil {
		return err
	}
	var req struct {
		Username string `json:"username"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	name := strings.TrimPrefix(strings.TrimSpace(req.Username), "@")
	if name == "" {
		return errBad("请输入要邀请的用户名")
	}
	me := currentUser(c)
	err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		if err := service.LockTrip(tx, t.ID); err != nil {
			return err
		}
		var target model.User
		if err := tx.Where("lower(username) = lower(?)", name).Limit(1).Find(&target).Error; err != nil {
			return err
		}
		if target.ID == 0 || target.Status == model.UserDeleted {
			return errNotFound("用户不存在")
		}
		if target.ID == me.ID {
			return errBad("不能邀请自己")
		}
		if target.Status == model.UserBanned {
			return errBad("该用户无法被邀请")
		}
		var existing model.TripMember
		if err := tx.Where("trip_id = ? AND user_id = ?", t.ID, target.ID).Limit(1).Find(&existing).Error; err != nil {
			return err
		}
		if existing.ID != 0 {
			if existing.Status == model.MemberAccepted {
				return errConflict("对方已是共同作者")
			}
			return errConflict("已邀请过对方，等待对方接受")
		}
		var n int64
		if err := tx.Model(&model.TripMember{}).Where("trip_id = ?", t.ID).Count(&n).Error; err != nil {
			return err
		}
		if n >= maxTripMembers {
			return errBad("共同作者人数已达上限")
		}
		partnerID, _, err := service.PartnerOf(tx, me.ID)
		if err != nil {
			return err
		}
		status, content := model.MemberPending, "邀请你成为旅程「"+t.Title+"」的共同作者"
		if partnerID == target.ID {
			status, content = model.MemberAccepted, "把你加入了共同旅程「"+t.Title+"」"
		}
		if err := tx.Create(&model.TripMember{TripID: t.ID, UserID: target.ID, Role: model.MemberEditor,
			Status: status, InvitedByID: me.ID}).Error; err != nil {
			return err
		}
		return h.svc.Notify(tx, service.Notice{UserID: target.ID, Type: "trip_invite", ActorID: me.ID, TripID: t.ID, Content: content})
	})
	if err != nil {
		return err
	}
	list, err := h.memberList(c, t.ID)
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, list)
	return nil
}

func (h *Handler) removeMember(c *gin.Context) error {
	t, a, err := h.tripForView(c)
	if err != nil {
		return err
	}
	uid, err := strconv.ParseInt(c.Param("user_id"), 10, 64)
	if err != nil || uid <= 0 {
		return errNotFound("成员不存在")
	}
	me := currentUser(c)
	if uid == t.OwnerID {
		return errBad("作者不能退出自己的旅程")
	}
	if !a.Owner && uid != me.ID {
		return errNotOwner
	}
	res := h.db.WithContext(c.Request.Context()).Where("trip_id = ? AND user_id = ? AND role <> ?", t.ID, uid, model.MemberOwner).
		Delete(&model.TripMember{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return errNotFound("成员不存在")
	}
	c.JSON(http.StatusOK, gin.H{})
	return nil
}

func (h *Handler) pendingInvite(c *gin.Context) (*model.TripMember, error) {
	id, err := idParam(c, "id")
	if err != nil {
		return nil, err
	}
	var m model.TripMember
	if err := h.db.WithContext(c.Request.Context()).Where("trip_id = ? AND user_id = ? AND status = ?", id, currentUserID(c), model.MemberPending).
		Limit(1).Find(&m).Error; err != nil {
		return nil, err
	}
	if m.ID == 0 {
		return nil, errNotFound("邀请不存在或已处理")
	}
	return &m, nil
}

func (h *Handler) acceptInvite(c *gin.Context) error {
	m, err := h.pendingInvite(c)
	if err != nil {
		return err
	}
	if err := h.db.WithContext(c.Request.Context()).Model(m).Update("status", model.MemberAccepted).Error; err != nil {
		return err
	}
	return h.respondTripDetail(c, m.TripID)
}

func (h *Handler) declineInvite(c *gin.Context) error {
	m, err := h.pendingInvite(c)
	if err != nil {
		return err
	}
	if err := h.db.WithContext(c.Request.Context()).Delete(m).Error; err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{})
	return nil
}
