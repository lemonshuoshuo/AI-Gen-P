package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"triphub/internal/model"
	"triphub/internal/service"
)

func (h *Handler) userByName(c *gin.Context) (*model.User, error) {
	var u model.User
	if err := h.db.WithContext(c.Request.Context()).Where("lower(username) = lower(?)", c.Param("username")).
		Limit(1).Find(&u).Error; err != nil {
		return nil, err
	}
	if u.ID == 0 {
		return nil, errNotFound("用户不存在")
	}
	return &u, nil
}

// publicMemberTrips selects trips of a user visible to the viewer: all of the
// user's trips for themselves, public & normal ones for everybody else.
func (h *Handler) publicMemberTrips(db *gorm.DB, target *model.User, viewer *model.User) *gorm.DB {
	q := db.Model(&model.Trip{}).Where("id IN (?)", service.MemberTripIDs(db, target.ID))
	if viewer == nil || viewer.ID != target.ID {
		q = q.Where("visibility = ? AND status = ?", model.VisPublic, model.TripNormal)
	}
	return q
}

func (h *Handler) userProfile(c *gin.Context) error {
	target, err := h.userByName(c)
	if err != nil {
		return err
	}
	viewer := currentUser(c)
	ctx := c.Request.Context()
	db := h.db.WithContext(ctx)
	var stats struct {
		Trips     int64 `json:"trips"`
		Followers int64 `json:"followers"`
		Following int64 `json:"following"`
		Likes     int64 `json:"likes"`
	}
	if err := h.publicMemberTrips(db, target, viewer).Count(&stats.Trips).Error; err != nil {
		return err
	}
	db.Model(&model.Follow{}).Where("followee_id = ?", target.ID).Count(&stats.Followers)
	db.Model(&model.Follow{}).Where("follower_id = ?", target.ID).Count(&stats.Following)
	db.Model(&model.Trip{}).Where("owner_id = ? AND visibility = ? AND status = ?", target.ID, model.VisPublic, model.TripNormal).
		Select("COALESCE(SUM(like_count), 0)").Scan(&stats.Likes)
	isFollowing := false
	if viewer != nil && viewer.ID != target.ID {
		var n int64
		db.Model(&model.Follow{}).Where("follower_id = ? AND followee_id = ?", viewer.ID, target.ID).Count(&n)
		isFollowing = n > 0
	}
	partnerID, _, err := service.PartnerOf(db, target.ID)
	if err != nil {
		return err
	}
	users, err := h.loadUsers(ctx, []int64{partnerID})
	if err != nil {
		return err
	}
	l, _ := service.LevelFor(target.Exp)
	c.JSON(http.StatusOK, gin.H{
		"id": target.ID, "username": target.Username, "nickname": userBrief(target).Nickname,
		"avatar_url": target.AvatarURL, "level": l.Level, "role": target.Role,
		"bio": target.Bio, "level_name": l.Name, "exp": target.Exp, "created_at": h.ts(target.CreatedAt),
		"stats": stats, "is_following": isFollowing, "is_me": viewer != nil && viewer.ID == target.ID,
		"partner": userBrief(users[partnerID]),
	})
	return nil
}

func (h *Handler) userTrips(c *gin.Context) error {
	target, err := h.userByName(c)
	if err != nil {
		return err
	}
	q := h.publicMemberTrips(h.db.WithContext(c.Request.Context()), target, currentUser(c))
	if p := c.Query("phase"); p != "" {
		if !validPhase(p) {
			return errBad("phase 参数无效")
		}
		q = q.Where("phase = ?", p)
	}
	return h.respondTripPage(c, q, "COALESCE(published_at, created_at) DESC, id DESC")
}

func (h *Handler) userFootprints(c *gin.Context) error {
	target, err := h.userByName(c)
	if err != nil {
		return err
	}
	db := h.db.WithContext(c.Request.Context())
	ids := h.publicMemberTrips(db, target, currentUser(c)).Select("id")
	fp, err := h.svc.BuildFootprints(db, ids)
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, fp)
	return nil
}

func (h *Handler) follow(c *gin.Context) error {
	target, err := h.userByName(c)
	if err != nil {
		return err
	}
	me := currentUser(c)
	if target.ID == me.ID {
		return errBad("不能关注自己")
	}
	var followers int64
	err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		res := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&model.Follow{FollowerID: me.ID, FolloweeID: target.ID})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected > 0 {
			if err := h.svc.Notify(tx, service.Notice{UserID: target.ID, Type: "follow", ActorID: me.ID}); err != nil {
				return err
			}
			if err := h.svc.AwardExp(tx, target.ID, service.ExpKey("followed", target.ID, me.ID), service.ExpFollowed, "followed"); err != nil {
				return err
			}
		}
		return tx.Model(&model.Follow{}).Where("followee_id = ?", target.ID).Count(&followers).Error
	})
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{"following": true, "followers": followers})
	return nil
}

func (h *Handler) unfollow(c *gin.Context) error {
	target, err := h.userByName(c)
	if err != nil {
		return err
	}
	me := currentUser(c)
	db := h.db.WithContext(c.Request.Context())
	if err := db.Where("follower_id = ? AND followee_id = ?", me.ID, target.ID).Delete(&model.Follow{}).Error; err != nil {
		return err
	}
	var followers int64
	db.Model(&model.Follow{}).Where("followee_id = ?", target.ID).Count(&followers)
	c.JSON(http.StatusOK, gin.H{"following": false, "followers": followers})
	return nil
}

func (h *Handler) followList(c *gin.Context, followers bool) error {
	target, err := h.userByName(c)
	if err != nil {
		return err
	}
	p := pageParams(c)
	db := h.db.WithContext(c.Request.Context())
	join, where := "JOIN follows f ON f.follower_id = users.id", "f.followee_id = ?"
	if !followers {
		join, where = "JOIN follows f ON f.followee_id = users.id", "f.follower_id = ?"
	}
	var users []model.User
	total, err := paginate(db.Model(&model.User{}).Joins(join).Where(where, target.ID), p, "f.created_at DESC", &users)
	if err != nil {
		return err
	}
	items := make([]*UserBrief, 0, len(users))
	for i := range users {
		items = append(items, userBrief(&users[i]))
	}
	c.JSON(http.StatusOK, newPage(items, total, p))
	return nil
}

func (h *Handler) followers(c *gin.Context) error { return h.followList(c, true) }
func (h *Handler) following(c *gin.Context) error { return h.followList(c, false) }
