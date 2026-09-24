package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"triphub/internal/model"
	"triphub/internal/service"
)

// shareCodeFrom reads an optional share code from the query or X-Share-Code header.
func shareCodeFrom(c *gin.Context) string {
	if v := c.Query("share_code"); v != "" {
		return v
	}
	return c.GetHeader("X-Share-Code")
}

// loadTrip loads a trip and the viewer's access, returning 404 when it is not viewable.
func (h *Handler) loadTrip(c *gin.Context, id int64, shareCode string) (*model.Trip, service.Access, error) {
	db := h.db.WithContext(c.Request.Context())
	var t model.Trip
	if err := db.Limit(1).Find(&t, id).Error; err != nil {
		return nil, service.Access{}, err
	}
	if t.ID == 0 {
		return nil, service.Access{}, errTripNotFound
	}
	a, err := h.svc.TripAccess(db, &t, currentUser(c), shareCode)
	if err != nil {
		return nil, a, err
	}
	if !a.CanView(&t) {
		return nil, a, errTripNotFound
	}
	return &t, a, nil
}

// tripForView loads the :id trip for reading (share codes accepted).
func (h *Handler) tripForView(c *gin.Context) (*model.Trip, service.Access, error) {
	id, err := idParam(c, "id")
	if err != nil {
		return nil, service.Access{}, err
	}
	return h.loadTrip(c, id, shareCodeFrom(c))
}

// tripForEdit loads the :id trip and requires an accepted member.
func (h *Handler) tripForEdit(c *gin.Context) (*model.Trip, service.Access, error) {
	t, a, err := h.tripForView(c)
	if err != nil {
		return nil, a, err
	}
	if !a.CanEdit() {
		return nil, a, errNotMember
	}
	return t, a, nil
}

// tripForOwner loads the :id trip and requires its owner.
func (h *Handler) tripForOwner(c *gin.Context) (*model.Trip, service.Access, error) {
	t, a, err := h.tripForView(c)
	if err != nil {
		return nil, a, err
	}
	if !a.Owner {
		return nil, a, errNotOwner
	}
	return t, a, nil
}

const hotScoreSQL = `(like_count * 3 + comment_count * 2 + fork_count * 5 + fav_count * 2 + view_count / 20.0)
 / power(extract(epoch from (now() - coalesce(published_at, created_at))) / 86400.0 + 2, 1.2)`

func (h *Handler) listTrips(c *gin.Context) error {
	db := h.db.WithContext(c.Request.Context())
	q := db.Model(&model.Trip{}).Where("visibility = ? AND status = ?", model.VisPublic, model.TripNormal)
	if kw := strings.TrimSpace(c.Query("q")); kw != "" {
		like := escapeLike(kw)
		q = q.Where("(title ILIKE ? OR summary ILIKE ? OR tags::text ILIKE ? OR cities::text ILIKE ? OR provinces::text ILIKE ?)",
			like, like, like, like, like)
	}
	if tag := strings.TrimSpace(c.Query("tag")); tag != "" {
		q = q.Where("tags @> ?::jsonb", jsonArray(tag))
	}
	if p := strings.TrimSpace(c.Query("province")); p != "" {
		q = q.Where("provinces::text ILIKE ?", escapeLike(p))
	}
	if city := strings.TrimSpace(c.Query("city")); city != "" {
		q = q.Where("cities::text ILIKE ?", escapeLike(city))
	}
	if p := c.Query("phase"); p != "" {
		if !validPhase(p) {
			return errBad("phase 参数无效")
		}
		q = q.Where("phase = ?", p)
	}
	order := "published_at DESC NULLS LAST, id DESC"
	switch c.DefaultQuery("tab", "latest") {
	case "latest", "":
	case "featured":
		q = q.Where("featured")
		order = "featured_at DESC NULLS LAST, id DESC"
	case "hot":
		order = hotScoreSQL + " DESC, published_at DESC NULLS LAST, id DESC"
	case "following":
		u := currentUser(c)
		if u == nil {
			return errLoginRequired
		}
		q = q.Where("owner_id IN (SELECT followee_id FROM follows WHERE follower_id = ?)", u.ID)
	default:
		return errBad("tab 参数无效")
	}
	return h.respondTripPage(c, q, order)
}

func jsonArray(s string) string {
	b, _ := json.Marshal([]string{s})
	return string(b)
}

// tripInput is the create/update request body.
type tripInput struct {
	Title       *string     `json:"title"`
	Summary     *string     `json:"summary"`
	Content     *string     `json:"content"`
	CoverURL    *string     `json:"cover_url"`
	Phase       *string     `json:"phase"`
	Visibility  *string     `json:"visibility"`
	StartDate   Opt[string] `json:"start_date"`
	EndDate     Opt[string] `json:"end_date"`
	Tags        *[]string   `json:"tags"`
	WithPartner bool        `json:"with_partner"`
}

// apply validates the input and writes changes into t, returning the
// changed column values.
func (in *tripInput) apply(t *model.Trip, creating bool) (map[string]any, error) {
	upd := map[string]any{}
	if in.Title != nil || creating {
		v := ""
		if in.Title != nil {
			v = *in.Title
		}
		s, err := clean(v, "标题", 100, true)
		if err != nil {
			return nil, err
		}
		t.Title, upd["title"] = s, s
	}
	if in.Summary != nil {
		s, err := clean(*in.Summary, "简介", 500, false)
		if err != nil {
			return nil, err
		}
		t.Summary, upd["summary"] = s, s
	}
	if in.Content != nil {
		if len([]rune(*in.Content)) > 50000 {
			return nil, errBad("正文不能超过 50000 字")
		}
		s := strings.ToValidUTF8(*in.Content, "")
		t.Content, upd["content"] = s, s
	}
	if in.CoverURL != nil {
		s, err := validURL(*in.CoverURL, "封面地址")
		if err != nil {
			return nil, err
		}
		t.CoverURL, upd["cover_url"] = s, s
	}
	if in.Phase != nil {
		if !validPhase(*in.Phase) {
			return nil, errBad("phase 只能是 planning / ongoing / finished")
		}
		t.Phase, upd["phase"] = *in.Phase, *in.Phase
	}
	if in.Visibility != nil {
		if !validVisibility(*in.Visibility) {
			return nil, errBad("visibility 只能是 private / unlisted / public")
		}
		t.Visibility, upd["visibility"] = *in.Visibility, *in.Visibility
	}
	if in.StartDate.Set {
		d, err := parseDate(in.StartDate.V, "start_date")
		if err != nil {
			return nil, err
		}
		t.StartDate, upd["start_date"] = d, d
	}
	if in.EndDate.Set {
		d, err := parseDate(in.EndDate.V, "end_date")
		if err != nil {
			return nil, err
		}
		t.EndDate, upd["end_date"] = d, d
	}
	if t.StartDate != nil && t.EndDate != nil {
		if t.EndDate.Before(*t.StartDate) {
			return nil, errBad("结束日期不能早于开始日期")
		}
		if t.EndDate.Sub(*t.StartDate) > 366*24*time.Hour {
			return nil, errBad("旅程时长不能超过一年")
		}
	}
	if in.Tags != nil {
		tags, err := cleanTags(*in.Tags)
		if err != nil {
			return nil, err
		}
		t.Tags, upd["tags"] = tags, service.JSONList(tags)
	}
	return upd, nil
}

func cleanTags(in []string) ([]string, error) {
	out := []string{}
	seen := map[string]bool{}
	for _, t := range in {
		t = strings.TrimPrefix(strings.TrimSpace(t), "#")
		if t == "" || seen[strings.ToLower(t)] {
			continue
		}
		if len([]rune(t)) > 20 {
			return nil, errBad("单个标签不能超过 20 个字")
		}
		seen[strings.ToLower(t)] = true
		out = append(out, t)
	}
	if len(out) > 10 {
		return nil, errBad("标签最多 10 个")
	}
	return out, nil
}

// createTripRecord inserts a trip (with a unique share code) and its owner row.
func createTripRecord(tx *gorm.DB, t *model.Trip) error {
	for attempt := 0; ; attempt++ {
		t.ShareCode = service.NewShareCode()
		err := tx.Transaction(func(tx2 *gorm.DB) error { return tx2.Create(t).Error })
		if err == nil {
			break
		}
		if !errors.Is(err, gorm.ErrDuplicatedKey) || attempt >= 3 {
			return err
		}
		t.ID = 0
	}
	return tx.Create(&model.TripMember{TripID: t.ID, UserID: t.OwnerID, Role: model.MemberOwner,
		Status: model.MemberAccepted, InvitedByID: t.OwnerID}).Error
}

func (h *Handler) createTrip(c *gin.Context) error {
	var in tripInput
	if err := bindJSON(c, &in); err != nil {
		return err
	}
	u := currentUser(c)
	t := model.Trip{OwnerID: u.ID, Phase: model.PhasePlanning, Visibility: model.VisPrivate, Status: model.TripNormal,
		Tags: []string{}, Cities: []string{}, Provinces: []string{}}
	if _, err := in.apply(&t, true); err != nil {
		return err
	}
	if t.StartDate != nil && t.EndDate != nil {
		t.Days = service.TripDays(t.StartDate, t.EndDate, nil, h.loc)
	}
	now := time.Now()
	if t.Visibility == model.VisPublic {
		t.PublishedAt = &now
	}
	ctx := c.Request.Context()
	err := h.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := createTripRecord(tx, &t); err != nil {
			return err
		}
		if in.WithPartner {
			partnerID, _, err := service.PartnerOf(tx, u.ID)
			if err != nil {
				return err
			}
			if partnerID != 0 {
				if err := tx.Create(&model.TripMember{TripID: t.ID, UserID: partnerID, Role: model.MemberEditor,
					Status: model.MemberAccepted, InvitedByID: u.ID}).Error; err != nil {
					return err
				}
				if err := h.svc.Notify(tx, service.Notice{UserID: partnerID, Type: "trip_invite", ActorID: u.ID, TripID: t.ID,
					Content: "把你加入了共同旅程「" + t.Title + "」"}); err != nil {
					return err
				}
			}
		}
		if err := h.svc.AwardExp(tx, u.ID, service.ExpKey("trip_create", t.ID), service.ExpCreateTrip, "trip_create"); err != nil {
			return err
		}
		if t.Visibility == model.VisPublic {
			return h.svc.AwardExp(tx, u.ID, service.ExpKey("trip_public", t.ID), service.ExpFirstPublic, "trip_public")
		}
		return nil
	})
	if err != nil {
		return err
	}
	return h.respondTripDetail(c, t.ID)
}

// respondTripDetail reloads a trip and responds with its TripDetail.
func (h *Handler) respondTripDetail(c *gin.Context, id int64) error {
	t, a, err := h.loadTrip(c, id, shareCodeFrom(c))
	if err != nil {
		return err
	}
	d, err := h.tripDetail(c.Request.Context(), t, a, currentUser(c))
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, d)
	return nil
}

func (h *Handler) countView(c *gin.Context, t *model.Trip, a service.Access) {
	if a.Member || a.Pending {
		return
	}
	viewer := c.ClientIP()
	if a.UserID != 0 {
		viewer = fmt.Sprintf("u%d", a.UserID)
	}
	if h.views.Allow(fmt.Sprintf("%d|%s", t.ID, viewer)) {
		h.db.WithContext(c.Request.Context()).Model(&model.Trip{}).Where("id = ?", t.ID).
			UpdateColumn("view_count", gorm.Expr("view_count + 1"))
		t.ViewCount++
	}
}

func (h *Handler) getTrip(c *gin.Context) error {
	t, a, err := h.tripForView(c)
	if err != nil {
		return err
	}
	h.countView(c, t, a)
	d, err := h.tripDetail(c.Request.Context(), t, a, currentUser(c))
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, d)
	return nil
}

func (h *Handler) getShared(c *gin.Context) error {
	code := c.Param("code")
	var t model.Trip
	if len(code) < 6 || len(code) > 16 {
		return errTripNotFound
	}
	db := h.db.WithContext(c.Request.Context())
	if err := db.Where("share_code = ?", code).Limit(1).Find(&t).Error; err != nil {
		return err
	}
	if t.ID == 0 {
		return errTripNotFound
	}
	a, err := h.svc.TripAccess(db, &t, currentUser(c), code)
	if err != nil {
		return err
	}
	if !a.CanView(&t) {
		return errTripNotFound
	}
	h.countView(c, &t, a)
	d, err := h.tripDetail(c.Request.Context(), &t, a, currentUser(c))
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, d)
	return nil
}

func (h *Handler) updateTrip(c *gin.Context) error {
	t, a, err := h.tripForEdit(c)
	if err != nil {
		return err
	}
	var in tripInput
	if err := bindJSON(c, &in); err != nil {
		return err
	}
	oldVis := t.Visibility
	if in.Visibility != nil && *in.Visibility != t.Visibility && !a.Owner {
		return errForbidden("只有作者可以修改可见性")
	}
	upd, err := in.apply(t, false)
	if err != nil {
		return err
	}
	if len(upd) == 0 {
		return h.respondTripDetail(c, t.ID)
	}
	firstPublic := t.Visibility == model.VisPublic && t.PublishedAt == nil
	if firstPublic {
		upd["published_at"] = time.Now()
	}
	err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&model.Trip{}).Where("id = ?", t.ID).Updates(upd).Error; err != nil {
			return err
		}
		if _, ok := upd["start_date"]; ok {
			if err := h.svc.RecomputeTrip(tx, t.ID); err != nil {
				return err
			}
		} else if _, ok := upd["end_date"]; ok {
			if err := h.svc.RecomputeTrip(tx, t.ID); err != nil {
				return err
			}
		}
		if oldVis != t.Visibility {
			ids, err := service.TripPlaceIDs(tx, t.ID)
			if err != nil {
				return err
			}
			if err := h.svc.RecomputePlaces(tx, ids); err != nil {
				return err
			}
		}
		if firstPublic {
			return h.svc.AwardExp(tx, t.OwnerID, service.ExpKey("trip_public", t.ID), service.ExpFirstPublic, "trip_public")
		}
		return nil
	})
	if err != nil {
		return err
	}
	return h.respondTripDetail(c, t.ID)
}

func (h *Handler) deleteTrip(c *gin.Context) error {
	t, a, err := h.tripForView(c)
	if err != nil {
		return err
	}
	if !a.Owner && !a.Admin {
		return errForbidden("只有作者或管理员可以删除旅程")
	}
	if err := h.svc.DeleteTrip(c.Request.Context(), t.ID); err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{})
	return nil
}

func (h *Handler) forkTrip(c *gin.Context) error {
	src, _, err := h.tripForView(c)
	if err != nil {
		return err
	}
	var req struct {
		Title string `json:"title"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	title, err := clean(req.Title, "标题", 100, false)
	if err != nil {
		return err
	}
	if title == "" {
		title = service.Truncate(src.Title, 95)
	}
	u := currentUser(c)
	srcID := src.ID
	nt := model.Trip{OwnerID: u.ID, Title: title, Summary: src.Summary, Phase: model.PhasePlanning,
		Visibility: model.VisPrivate, Status: model.TripNormal, Tags: nonNil(src.Tags), Cities: []string{}, Provinces: []string{},
		ForkedFromID: &srcID}
	err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		if err := createTripRecord(tx, &nt); err != nil {
			return err
		}
		var wps []model.Waypoint
		if err := tx.Where("trip_id = ? AND status <> ?", src.ID, model.WPSkipped).Order("seq, id").Find(&wps).Error; err != nil {
			return err
		}
		copies := make([]model.Waypoint, 0, len(wps))
		for i, w := range wps {
			copies = append(copies, model.Waypoint{
				TripID: nt.ID, Seq: i, Day: w.Day, Planned: true, Status: model.WPTodo,
				Name: w.Name, Address: w.Address, Province: w.Province, ProvinceCode: w.ProvinceCode,
				City: w.City, CityCode: w.CityCode, District: w.District, Lng: w.Lng, Lat: w.Lat,
				Category: w.Category, Note: w.Note, Cost: w.Cost, AmapID: w.AmapID, PlaceID: w.PlaceID,
				AutoNamed: w.AutoNamed, CreatedByID: u.ID,
			})
		}
		if len(copies) > 0 {
			if err := tx.CreateInBatches(&copies, 200).Error; err != nil {
				return err
			}
		}
		if err := h.svc.RecomputeTrip(tx, nt.ID); err != nil {
			return err
		}
		if src.OwnerID == u.ID {
			return nil
		}
		if err := tx.Model(&model.Trip{}).Where("id = ?", src.ID).UpdateColumn("fork_count", gorm.Expr("fork_count + 1")).Error; err != nil {
			return err
		}
		if err := h.svc.Notify(tx, service.Notice{UserID: src.OwnerID, Type: "fork", ActorID: u.ID, TripID: src.ID,
			Content: "引用了你的路线「" + src.Title + "」"}); err != nil {
			return err
		}
		return h.svc.AwardExp(tx, src.OwnerID, service.ExpKey("forked", src.ID, u.ID), service.ExpForked, "forked")
	})
	if err != nil {
		return err
	}
	return h.respondTripDetail(c, nt.ID)
}

// toggle handles like/favorite insertion or removal and returns the new count.
func (h *Handler) toggle(c *gin.Context, table string, on bool) (int, *model.Trip, error) {
	t, _, err := h.tripForView(c)
	if err != nil {
		return 0, nil, err
	}
	u := currentUser(c)
	counter := map[string]string{"likes": "like_count", "favorites": "fav_count"}[table]
	var count int
	err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		changed := int64(0)
		if on {
			var res *gorm.DB
			if table == "likes" {
				res = tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&model.Like{UserID: u.ID, TripID: t.ID})
			} else {
				res = tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&model.Favorite{UserID: u.ID, TripID: t.ID})
			}
			if res.Error != nil {
				return res.Error
			}
			changed = res.RowsAffected
		} else {
			res := tx.Exec("DELETE FROM "+table+" WHERE user_id = ? AND trip_id = ?", u.ID, t.ID)
			if res.Error != nil {
				return res.Error
			}
			changed = res.RowsAffected
		}
		if err := tx.Raw("UPDATE trips SET "+counter+" = (SELECT COUNT(*) FROM "+table+" WHERE trip_id = ?) WHERE id = ? RETURNING "+counter,
			t.ID, t.ID).Scan(&count).Error; err != nil {
			return err
		}
		if !on || changed == 0 {
			return nil
		}
		typ, key, exp, verb := "like", "liked", service.ExpLiked, "赞了你的旅程"
		if table == "favorites" {
			typ, key, exp, verb = "favorite", "fav", service.ExpFavorited, "收藏了你的旅程"
		}
		if err := h.svc.Notify(tx, service.Notice{UserID: t.OwnerID, Type: typ, ActorID: u.ID, TripID: t.ID,
			Content: verb + "「" + t.Title + "」"}); err != nil {
			return err
		}
		if t.OwnerID == u.ID {
			return nil
		}
		return h.svc.AwardExp(tx, t.OwnerID, service.ExpKey(key, t.ID, u.ID), exp, key)
	})
	return count, t, err
}

func (h *Handler) like(c *gin.Context) error {
	n, _, err := h.toggle(c, "likes", true)
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{"liked": true, "like_count": n})
	return nil
}

func (h *Handler) unlike(c *gin.Context) error {
	n, _, err := h.toggle(c, "likes", false)
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{"liked": false, "like_count": n})
	return nil
}

func (h *Handler) favorite(c *gin.Context) error {
	n, _, err := h.toggle(c, "favorites", true)
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{"favorited": true, "fav_count": n})
	return nil
}

func (h *Handler) unfavorite(c *gin.Context) error {
	n, _, err := h.toggle(c, "favorites", false)
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{"favorited": false, "fav_count": n})
	return nil
}

func (h *Handler) resetShareCode(c *gin.Context) error {
	t, _, err := h.tripForOwner(c)
	if err != nil {
		return err
	}
	db := h.db.WithContext(c.Request.Context())
	for attempt := 0; ; attempt++ {
		code := service.NewShareCode()
		err := db.Model(&model.Trip{}).Where("id = ?", t.ID).UpdateColumn("share_code", code).Error
		if err == nil {
			c.JSON(http.StatusOK, gin.H{"share_code": code})
			return nil
		}
		if !errors.Is(err, gorm.ErrDuplicatedKey) || attempt >= 3 {
			return err
		}
	}
}
