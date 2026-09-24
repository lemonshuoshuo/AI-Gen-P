package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"triphub/internal/model"
)

type notificationDTO struct {
	ID        int64      `json:"id"`
	Type      string     `json:"type"`
	Actor     *UserBrief `json:"actor"`
	Trip      *TripRef   `json:"trip"`
	Place     *PlaceRef  `json:"place"`
	CommentID *int64     `json:"comment_id"`
	Content   string     `json:"content"`
	Read      bool       `json:"read"`
	// InvitePending: a trip_invite whose invitation still awaits the
	// recipient's answer (clients show accept / decline).
	InvitePending bool   `json:"invite_pending"`
	CreatedAt     string `json:"created_at"`
}

func (h *Handler) listNotifications(c *gin.Context) error {
	u := currentUser(c)
	ctx := c.Request.Context()
	db := h.db.WithContext(ctx)
	q := db.Model(&model.Notification{}).Where("user_id = ?", u.ID)
	if queryBool(c, "unread_only") {
		q = q.Where("NOT read")
	}
	p := pageParams(c)
	var ns []model.Notification
	total, err := paginate(q, p, "id DESC", &ns)
	if err != nil {
		return err
	}
	var actorIDs, tripIDs, placeIDs []int64
	for _, n := range ns {
		if n.ActorID != nil {
			actorIDs = append(actorIDs, *n.ActorID)
		}
		if n.TripID != nil {
			tripIDs = append(tripIDs, *n.TripID)
		}
		if n.PlaceID != nil {
			placeIDs = append(placeIDs, *n.PlaceID)
		}
	}
	users, err := h.loadUsers(ctx, actorIDs)
	if err != nil {
		return err
	}
	// Only reveal trips the recipient can still see.
	trips := map[int64]TripRef{}
	invitePending := map[int64]bool{} // trips the recipient is invited to and has not answered
	if len(tripIDs) > 0 {
		var ts []model.Trip
		if err := db.Select("id", "title", "owner_id", "visibility", "status").Where("id IN ?", uniq(tripIDs)).Find(&ts).Error; err != nil {
			return err
		}
		var memberOf []model.TripMember
		if err := db.Select("trip_id", "status").Where("user_id = ? AND trip_id IN ?", u.ID, uniq(tripIDs)).
			Find(&memberOf).Error; err != nil {
			return err
		}
		isMember := map[int64]bool{}
		for _, m := range memberOf {
			isMember[m.TripID] = true
			if m.Status == model.MemberPending {
				invitePending[m.TripID] = true
			}
		}
		for _, t := range ts {
			if u.IsAdmin() || isMember[t.ID] || (t.Visibility == model.VisPublic && t.Status == model.TripNormal) {
				trips[t.ID] = TripRef{ID: t.ID, Title: t.Title}
			}
		}
	}
	places := map[int64]PlaceRef{}
	if len(placeIDs) > 0 {
		var ps []model.Place
		if err := db.Select("id", "name").Where("id IN ?", uniq(placeIDs)).Find(&ps).Error; err != nil {
			return err
		}
		for _, pl := range ps {
			places[pl.ID] = PlaceRef{ID: pl.ID, Name: pl.Name}
		}
	}
	items := make([]notificationDTO, 0, len(ns))
	for _, n := range ns {
		d := notificationDTO{ID: n.ID, Type: n.Type, CommentID: n.CommentID, Content: n.Content, Read: n.Read, CreatedAt: h.ts(n.CreatedAt)}
		if n.ActorID != nil {
			d.Actor = userBrief(users[*n.ActorID])
		}
		if n.TripID != nil {
			if t, ok := trips[*n.TripID]; ok {
				d.Trip = &t
				d.InvitePending = n.Type == "trip_invite" && invitePending[t.ID]
			} else {
				d.CommentID = nil // the trip is no longer visible to the recipient
				if n.Type == "comment" || n.Type == "reply" {
					d.Content = ""
				}
			}
		}
		if n.PlaceID != nil {
			if pl, ok := places[*n.PlaceID]; ok {
				d.Place = &pl
			}
		}
		items = append(items, d)
	}
	c.JSON(http.StatusOK, newPage(items, total, p))
	return nil
}

func (h *Handler) unreadCount(c *gin.Context) error {
	var n int64
	if err := h.db.WithContext(c.Request.Context()).Model(&model.Notification{}).
		Where("user_id = ? AND NOT read", currentUserID(c)).Count(&n).Error; err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{"count": n})
	return nil
}

func (h *Handler) markRead(c *gin.Context) error {
	var req struct {
		IDs []int64 `json:"ids"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	q := h.db.WithContext(c.Request.Context()).Model(&model.Notification{}).Where("user_id = ? AND NOT read", currentUserID(c))
	if req.IDs != nil {
		if len(req.IDs) == 0 {
			c.JSON(http.StatusOK, gin.H{"updated": 0})
			return nil
		}
		q = q.Where("id IN ?", req.IDs)
	}
	res := q.Update("read", true)
	if res.Error != nil {
		return res.Error
	}
	c.JSON(http.StatusOK, gin.H{"updated": res.RowsAffected})
	return nil
}
