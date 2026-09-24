package handler

import (
	"context"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"triphub/internal/model"
	"triphub/internal/service"
)

// topLevelVisible selects top-level comments that are not deleted or still have live replies.
const topLevelVisible = "parent_id IS NULL AND (NOT deleted OR EXISTS (SELECT 1 FROM comments r WHERE r.parent_id = comments.id AND NOT r.deleted))"

func (h *Handler) respondComments(c *gin.Context, q *gorm.DB, tripOwner int64) error {
	p := pageParams(c)
	var tops []model.Comment
	total, err := paginate(q.Where(topLevelVisible), p, "created_at DESC, id DESC", &tops)
	if err != nil {
		return err
	}
	items, err := h.commentDTOs(c.Request.Context(), tops, true, currentUser(c), tripOwner)
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, newPage(items, total, p))
	return nil
}

func (h *Handler) tripComments(c *gin.Context) error {
	t, _, err := h.tripForView(c)
	if err != nil {
		return err
	}
	q := h.db.WithContext(c.Request.Context()).Model(&model.Comment{}).Where("trip_id = ?", t.ID)
	if wid, ok := queryInt64(c, "waypoint_id"); ok {
		q = q.Where("waypoint_id = ?", wid)
	}
	return h.respondComments(c, q, t.OwnerID)
}

type commentInput struct {
	Content    string `json:"content"`
	ParentID   *int64 `json:"parent_id"`
	WaypointID *int64 `json:"waypoint_id"`
}

// prepareComment validates content and resolves the parent (flattening
// replies-to-replies onto the top-level comment).
func (h *Handler) prepareComment(c *gin.Context, in *commentInput, scope string, scopeID int64) (*model.Comment, *model.Comment, error) {
	content, err := clean(in.Content, "评论内容", 1000, true)
	if err != nil {
		return nil, nil, err
	}
	u := currentUser(c)
	if !h.commentLimit.Allow(strconv.FormatInt(u.ID, 10)) {
		return nil, nil, errTooMany("评论过于频繁，请稍后再试")
	}
	if err := h.screen(c, content); err != nil { // after the limit: rejected attempts count too
		return nil, nil, err
	}
	cm := &model.Comment{UserID: u.ID, Content: content}
	var parent *model.Comment
	if in.ParentID != nil && *in.ParentID != 0 {
		var p model.Comment
		if err := h.db.WithContext(c.Request.Context()).Where("id = ? AND "+scope+" = ?", *in.ParentID, scopeID).
			Limit(1).Find(&p).Error; err != nil {
			return nil, nil, err
		}
		if p.ID == 0 {
			return nil, nil, errBad("回复的评论不存在")
		}
		if p.Deleted {
			return nil, nil, errBad("该评论已被删除，无法回复")
		}
		parent = &p
		if p.ParentID != nil {
			// Reply to a reply: attach to the same top-level comment.
			cm.ParentID = p.ParentID
			replyTo := p.UserID
			cm.ReplyToUserID = &replyTo
		} else {
			pid := p.ID
			cm.ParentID = &pid
		}
		cm.WaypointID = p.WaypointID
	}
	return cm, parent, nil
}

func (h *Handler) postTripComment(c *gin.Context) error {
	t, _, err := h.tripForView(c)
	if err != nil {
		return err
	}
	var in commentInput
	if err := bindJSON(c, &in); err != nil {
		return err
	}
	cm, parent, err := h.prepareComment(c, &in, "trip_id", t.ID)
	if err != nil {
		return err
	}
	tid := t.ID
	cm.TripID = &tid
	if parent == nil && in.WaypointID != nil && *in.WaypointID != 0 {
		var n int64
		if err := h.db.WithContext(c.Request.Context()).Model(&model.Waypoint{}).
			Where("id = ? AND trip_id = ?", *in.WaypointID, t.ID).Count(&n).Error; err != nil {
			return err
		}
		if n == 0 {
			return errBad("打卡点不属于该旅程")
		}
		wid := *in.WaypointID
		cm.WaypointID = &wid
	}
	u := currentUser(c)
	excerpt := service.Truncate(cm.Content, 60)
	err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		if err := service.LockTrip(tx, t.ID); err != nil { // serialise the comment_count recount
			return err
		}
		if err := tx.Create(cm).Error; err != nil {
			return err
		}
		if err := h.recountTripComments(tx, t.ID); err != nil {
			return err
		}
		replyTarget := int64(0)
		if parent != nil {
			replyTarget = parent.UserID
			if err := h.svc.Notify(tx, service.Notice{UserID: replyTarget, Type: "reply", ActorID: u.ID, TripID: t.ID,
				CommentID: cm.ID, Content: excerpt}); err != nil {
				return err
			}
		}
		if t.OwnerID != replyTarget {
			if err := h.svc.Notify(tx, service.Notice{UserID: t.OwnerID, Type: "comment", ActorID: u.ID, TripID: t.ID,
				CommentID: cm.ID, Content: excerpt}); err != nil {
				return err
			}
		}
		if err := h.svc.AwardExp(tx, u.ID, service.ExpKey("comment", cm.ID), service.ExpComment, "comment"); err != nil {
			return err
		}
		if t.OwnerID != u.ID {
			return h.svc.AwardExp(tx, t.OwnerID, service.ExpKey("commented", t.ID, u.ID), service.ExpCommented, "commented")
		}
		return nil
	})
	if err != nil {
		return err
	}
	items, err := h.commentDTOs(c.Request.Context(), []model.Comment{*cm}, false, u, t.OwnerID)
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, items[0])
	return nil
}

// recountTripComments refreshes a trip's comment_count; callers that add or
// delete comments lock the trip first (service.LockTrip).
func (h *Handler) recountTripComments(tx *gorm.DB, tripID int64) error {
	return tx.Exec("UPDATE trips SET comment_count = (SELECT COUNT(*) FROM comments WHERE trip_id = ? AND NOT deleted) WHERE id = ?",
		tripID, tripID).Error
}

// visiblePlaceIDs returns which of the places ids the viewer u (nil = guest)
// may open: places with public check-ins, an AMap POI ID, or used by a
// public trip are public; others are visible only to members (accepted or
// invited) of a trip using them, and to admins.
func (h *Handler) visiblePlaceIDs(ctx context.Context, u *model.User, ids []int64) (map[int64]bool, error) {
	out := map[int64]bool{}
	if len(ids) == 0 {
		return out, nil
	}
	q := h.db.WithContext(ctx).Model(&model.Place{}).Where("id IN ?", ids)
	if !u.IsAdmin() {
		uid := int64(0)
		if u != nil {
			uid = u.ID
		}
		q = q.Where(`(checkin_count > 0 OR amap_id <> '' OR EXISTS (
  SELECT 1 FROM waypoints w JOIN trips t ON t.id = w.trip_id WHERE w.place_id = places.id AND (
    (t.visibility = ? AND t.status = ?) OR
    w.trip_id IN (SELECT trip_id FROM trip_members WHERE user_id = ? AND status IN ?))))`,
			model.VisPublic, model.TripNormal, uid, []string{model.MemberAccepted, model.MemberPending})
	}
	var visible []int64
	if err := q.Pluck("id", &visible).Error; err != nil {
		return nil, err
	}
	for _, id := range visible {
		out[id] = true
	}
	return out, nil
}

// loadPlace loads the :id place if the viewer may open it (see visiblePlaceIDs).
func (h *Handler) loadPlace(c *gin.Context) (*model.Place, error) {
	id, err := idParam(c, "id")
	if err != nil {
		return nil, err
	}
	db := h.db.WithContext(c.Request.Context())
	var p model.Place
	if err := db.Limit(1).Find(&p, id).Error; err != nil {
		return nil, err
	}
	if p.ID == 0 {
		return nil, errNotFound("地点不存在")
	}
	u := currentUser(c)
	if p.CheckinCount > 0 || p.AmapID != "" || u.IsAdmin() {
		return &p, nil
	}
	vis, err := h.visiblePlaceIDs(c.Request.Context(), u, []int64{p.ID})
	if err != nil {
		return nil, err
	}
	if vis[p.ID] {
		return &p, nil
	}
	return nil, errNotFound("地点不存在")
}

func (h *Handler) placeComments(c *gin.Context) error {
	p, err := h.loadPlace(c)
	if err != nil {
		return err
	}
	return h.respondComments(c, h.db.WithContext(c.Request.Context()).Model(&model.Comment{}).Where("place_id = ?", p.ID), 0)
}

func (h *Handler) postPlaceComment(c *gin.Context) error {
	p, err := h.loadPlace(c)
	if err != nil {
		return err
	}
	var in commentInput
	if err := bindJSON(c, &in); err != nil {
		return err
	}
	in.WaypointID = nil
	cm, parent, err := h.prepareComment(c, &in, "place_id", p.ID)
	if err != nil {
		return err
	}
	cm.WaypointID = nil
	pid := p.ID
	cm.PlaceID = &pid
	u := currentUser(c)
	err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		if err := service.LockPlace(tx, p.ID); err != nil { // serialise the comment_count recount
			return err
		}
		if err := tx.Create(cm).Error; err != nil {
			return err
		}
		if err := tx.Exec("UPDATE places SET comment_count = (SELECT COUNT(*) FROM comments WHERE place_id = ? AND NOT deleted) WHERE id = ?",
			p.ID, p.ID).Error; err != nil {
			return err
		}
		if parent != nil {
			if err := h.svc.Notify(tx, service.Notice{UserID: parent.UserID, Type: "reply", ActorID: u.ID, PlaceID: p.ID,
				CommentID: cm.ID, Content: service.Truncate(cm.Content, 60)}); err != nil {
				return err
			}
		}
		return h.svc.AwardExp(tx, u.ID, service.ExpKey("comment", cm.ID), service.ExpComment, "comment")
	})
	if err != nil {
		return err
	}
	items, err := h.commentDTOs(c.Request.Context(), []model.Comment{*cm}, false, u, 0)
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, items[0])
	return nil
}

// softDeleteComment marks a comment deleted and refreshes counters.
func (h *Handler) softDeleteComment(c *gin.Context, cm *model.Comment) error {
	return h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		// Lock before touching the comment: deleteWaypoint locks the trip and
		// then updates comments, so the reverse order could deadlock.
		if cm.TripID != nil {
			if err := service.LockTrip(tx, *cm.TripID); err != nil {
				return err
			}
		}
		if cm.PlaceID != nil {
			if err := service.LockPlace(tx, *cm.PlaceID); err != nil {
				return err
			}
		}
		if err := tx.Model(cm).Updates(map[string]any{"deleted": true, "content": ""}).Error; err != nil {
			return err
		}
		if cm.TripID != nil {
			if err := h.recountTripComments(tx, *cm.TripID); err != nil {
				return err
			}
		}
		if cm.PlaceID != nil {
			return tx.Exec("UPDATE places SET comment_count = (SELECT COUNT(*) FROM comments WHERE place_id = ? AND NOT deleted) WHERE id = ?",
				*cm.PlaceID, *cm.PlaceID).Error
		}
		return nil
	})
}

func (h *Handler) findComment(c *gin.Context) (*model.Comment, error) {
	id, err := idParam(c, "id")
	if err != nil {
		return nil, err
	}
	var cm model.Comment
	if err := h.db.WithContext(c.Request.Context()).Limit(1).Find(&cm, id).Error; err != nil {
		return nil, err
	}
	if cm.ID == 0 || cm.Deleted {
		return nil, errNotFound("评论不存在")
	}
	return &cm, nil
}

func (h *Handler) deleteComment(c *gin.Context) error {
	cm, err := h.findComment(c)
	if err != nil {
		return err
	}
	u := currentUser(c)
	allowed := cm.UserID == u.ID || u.IsAdmin()
	if !allowed && cm.TripID != nil {
		var t model.Trip
		if err := h.db.WithContext(c.Request.Context()).Select("id", "owner_id").Limit(1).Find(&t, *cm.TripID).Error; err != nil {
			return err
		}
		allowed = t.OwnerID == u.ID
	}
	if !allowed {
		return errForbidden("无权删除该评论")
	}
	if err := h.softDeleteComment(c, cm); err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{})
	return nil
}
