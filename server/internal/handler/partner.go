package handler

import (
	"fmt"
	"net/http"
	"slices"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"triphub/internal/model"
	"triphub/internal/service"
)

// Deprecated API of older clients: /partner is the user's couple space
// (spaces.go). A couple is a couple space with two members; the invitations
// are invitations to couple spaces, and their IDs are those of
// /space-invites.

// coupleInvites loads the current user's pending invitations to couple
// spaces: received (incoming) or sent.
func (h *Handler) coupleInvites(c *gin.Context, incoming bool) ([]model.SpaceInvite, error) {
	col := "inviter_id"
	if incoming {
		col = "invitee_id"
	}
	var invs []model.SpaceInvite
	err := h.db.WithContext(c.Request.Context()).Where(col+" = ? AND status = ? AND space_id IN (SELECT id FROM spaces WHERE type = ?)",
		currentUserID(c), model.InvitePending, model.SpaceCouple).Order("created_at DESC, id DESC").Find(&invs).Error
	return invs, err
}

func (h *Handler) partnerState(c *gin.Context) (gin.H, error) {
	ctx := c.Request.Context()
	db := h.db.WithContext(ctx)
	u := currentUser(c)
	partnerID, sp, err := service.PartnerOf(db, u.ID)
	if err != nil {
		return nil, err
	}
	incoming, err := h.coupleInvites(c, true)
	if err != nil {
		return nil, err
	}
	outgoing, err := h.coupleInvites(c, false)
	if err != nil {
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
	res := gin.H{"partner": nil, "since": nil, "title": "", "bound_at": nil, "public": false, "space_id": nil,
		"invites": gin.H{"incoming": in, "outgoing": out}}
	if sp != nil {
		res["space_id"] = sp.ID
	}
	if partnerID != 0 {
		users, err := h.loadUsers(ctx, []int64{partnerID})
		if err != nil {
			return nil, err
		}
		// Bound when the second of them joined.
		var joined []model.SpaceMember
		if err := db.Where("space_id = ?", sp.ID).Order("joined_at DESC").Limit(1).Find(&joined).Error; err != nil {
			return nil, err
		}
		res["partner"] = userBrief(users[partnerID])
		res["since"] = service.FormatDate(sp.Anniversary)
		res["title"] = sp.Name
		if len(joined) > 0 {
			res["bound_at"] = h.ts(joined[0].JoinedAt)
		}
		res["public"] = sp.Public
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

// partnerSpace returns the current user's couple space when they have a
// partner (400 otherwise), with the partner.
func (h *Handler) partnerSpace(c *gin.Context, db *gorm.DB) (*model.Space, int64, error) {
	partnerID, sp, err := service.PartnerOf(db, currentUserID(c))
	if err != nil {
		return nil, 0, err
	}
	if partnerID == 0 {
		return nil, 0, errBad("尚未绑定情侣")
	}
	return sp, partnerID, nil
}

// updatePartner changes the couple space (PATCH /spaces/:id): since is its
// anniversary, title its name (「我们」 when empty), public whether profiles
// show the relationship. Both partners may.
func (h *Handler) updatePartner(c *gin.Context) error {
	var req struct {
		Since  Opt[string] `json:"since"`
		Title  *string     `json:"title"`
		Public *bool       `json:"public"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	db := h.db.WithContext(c.Request.Context())
	sp, _, err := h.partnerSpace(c, db)
	if err != nil {
		return err
	}
	in := spaceInput{Anniversary: req.Since, Public: req.Public}
	if req.Title != nil {
		name := *req.Title
		if t, err := clean(name, "空间名称", maxSpaceName, false); err == nil && t == "" {
			name = service.DefaultSpaceName(model.SpaceCouple, "")
		}
		in.Name = &name
	}
	err = db.Transaction(func(tx *gorm.DB) error {
		cur, m, err := lockSpaceMember(tx, sp.ID, currentUserID(c))
		if err != nil {
			return err
		}
		if !canManageSpace(cur, m.Role) {
			return errForbidden("只有空间的创建者可以修改空间设置")
		}
		upd, err := h.applySpace(c, cur, &in, false)
		if err != nil || len(upd) == 0 {
			return err
		}
		return tx.Model(&model.Space{}).Where("id = ?", cur.ID).Updates(upd).Error
	})
	if err != nil {
		return err
	}
	return h.getPartner(c)
}

// unbindPartner ends the couple: the couple space is deleted (the trips
// stay with their authors). With ?remove_shared_access=true each partner
// also stops being a co-author (or invitee) of the trips the other owns;
// otherwise both keep full access to them until removed in the trip's
// members.
func (h *Handler) unbindPartner(c *gin.Context) error {
	u := currentUser(c)
	removeShared := queryBool(c, "remove_shared_access")
	err := h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		sp, partnerID, err := h.partnerSpace(c, tx)
		if err != nil {
			return err
		}
		cur, _, err := lockSpaceMember(tx, sp.ID, u.ID)
		if err != nil {
			return err
		}
		// Memberships of one in trips the other owns.
		coAuthor := func(owner, member int64) *gorm.DB {
			return tx.Model(&model.TripMember{}).Where("user_id = ? AND role <> ? AND trip_id IN (?)", member, model.MemberOwner,
				tx.Model(&model.Trip{}).Select("id").Where("owner_id = ?", owner))
		}
		var sharedTrips, linked []int64
		for _, om := range [][2]int64{{u.ID, partnerID}, {partnerID, u.ID}} {
			var ids []int64
			if err := coAuthor(om[0], om[1]).Pluck("trip_id", &ids).Error; err != nil {
				return err
			}
			sharedTrips = append(sharedTrips, ids...)
		}
		if err := tx.Model(&model.Trip{}).Where("space_id = ?", cur.ID).Pluck("id", &linked).Error; err != nil {
			return err
		}
		shared := len(sharedTrips)
		if removeShared && shared > 0 {
			// All the trips that change, locked at once in id order (as
			// other changes of several trips lock them).
			all := slices.Sorted(slices.Values(uniq(append(append([]int64{}, sharedTrips...), linked...))))
			if err := tx.Exec("SELECT id FROM trips WHERE id IN ? ORDER BY id FOR UPDATE", all).Error; err != nil {
				return err
			}
		}
		if _, err := service.DeleteSpace(tx, cur.ID, u.ID); err != nil { // counts a revision of the linked trips
			return err
		}
		if removeShared && shared > 0 {
			var others []int64 // the trips whose revision DeleteSpace did not count
			for _, id := range sharedTrips {
				if !slices.Contains(linked, id) {
					others = append(others, id)
				}
			}
			if err := service.TouchTrips(tx, others, u.ID); err != nil {
				return err
			}
			for _, om := range [][2]int64{{u.ID, partnerID}, {partnerID, u.ID}} {
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
		return h.svc.Notify(tx, service.Notice{UserID: partnerID, Type: "system", ActorID: u.ID, SpaceID: cur.ID, Content: content})
	})
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{})
	return nil
}

// createPartnerInvite invites a user to the current user's couple space,
// created (「我们」) when they have none.
func (h *Handler) createPartnerInvite(c *gin.Context) error {
	var req struct {
		Username string `json:"username"`
		Message  string `json:"message"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	target, err := h.findInvitee(c, 0, req.Username)
	if err != nil {
		return err
	}
	msg, err := h.inviteMessage(c, req.Message)
	if err != nil {
		return err
	}
	u := currentUser(c)
	var inv *model.SpaceInvite
	err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		if err := service.LockUser(tx, u.ID); err != nil {
			return err
		}
		partnerID, sp, err := service.PartnerOf(tx, u.ID)
		if err != nil {
			return err
		}
		if partnerID != 0 {
			return errConflict("你已绑定情侣，请先解除绑定")
		}
		if tp, _, err := service.PartnerOf(tx, target.ID); err != nil {
			return err
		} else if tp != 0 {
			return errConflict("对方已绑定情侣")
		}
		if sp == nil {
			n, err := countSpacesOf(tx, u.ID)
			if err != nil {
				return err
			}
			if n >= service.MaxSpacesPerUser {
				return errBad(fmt.Sprintf("最多加入 %d 个空间，请先退出一些空间", service.MaxSpacesPerUser))
			}
			sp = &model.Space{Name: service.DefaultSpaceName(model.SpaceCouple, ""), Type: model.SpaceCouple, OwnerID: u.ID}
			if err := tx.Create(sp).Error; err != nil {
				return err
			}
			if err := tx.Create(&model.SpaceMember{SpaceID: sp.ID, UserID: u.ID, Role: model.SpaceRoleOwner, JoinedAt: sp.CreatedAt,
				Couple: true}).Error; err != nil {
				return err
			}
		}
		inv, err = h.inviteToSpace(c, tx, sp.ID, target, msg)
		return err
	})
	if err != nil {
		return err
	}
	dtos, err := h.partnerInviteDTOs(c.Request.Context(), []model.SpaceInvite{*inv})
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, dtos[0])
	return nil
}

func (h *Handler) acceptPartnerInvite(c *gin.Context) error {
	id, err := idParam(c, "id")
	if err != nil {
		return errInviteNotFound
	}
	if _, err := h.joinSpace(c, id, true); err != nil {
		return err
	}
	return h.getPartner(c)
}

func (h *Handler) declinePartnerInvite(c *gin.Context) error {
	id, err := idParam(c, "id")
	if err != nil {
		return errInviteNotFound
	}
	if err := h.answerSpaceInvite(c, id, true, true); err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{})
	return nil
}

func (h *Handler) cancelPartnerInvite(c *gin.Context) error {
	id, err := idParam(c, "id")
	if err != nil {
		return errInviteNotFound
	}
	if err := h.answerSpaceInvite(c, id, false, true); err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{})
	return nil
}

// partnerTrips lists the trips of the couple space (GET /spaces/:id/trips).
func (h *Handler) partnerTrips(c *gin.Context) error {
	db := h.db.WithContext(c.Request.Context())
	partnerID, sp, err := service.PartnerOf(db, currentUserID(c))
	if err != nil {
		return err
	}
	if partnerID == 0 {
		p := pageParams(c)
		c.JSON(http.StatusOK, newPage([]TripCard{}, 0, p))
		return nil
	}
	return h.respondTripPage(c, db.Model(&model.Trip{}).Where("space_id = ?", sp.ID), service.SpaceTripOrder())
}

// partnerFootprints is the footprints of the couple space (GET /spaces/:id/footprints).
func (h *Handler) partnerFootprints(c *gin.Context) error {
	db := h.db.WithContext(c.Request.Context())
	partnerID, sp, err := service.PartnerOf(db, currentUserID(c))
	if err != nil {
		return err
	}
	if partnerID == 0 {
		c.JSON(http.StatusOK, service.EmptyFootprints())
		return nil
	}
	fp, err := h.svc.BuildFootprints(db, service.SpaceTripIDs(db, sp.ID))
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, fp)
	return nil
}
