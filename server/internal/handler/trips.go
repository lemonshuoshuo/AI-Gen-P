package handler

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
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

// hotScoreSQL is evaluated in float8. The numeric form (x / 20.0, extract(epoch), numeric power())
// costs about 19 µs per public trip on every hot page or search; float8 costs about 1 µs.
const hotScoreSQL = `(like_count * 3 + comment_count * 2 + fork_count * 5 + fav_count * 2 + view_count / 20.0::float8)
 / power(date_part('epoch', now() - coalesce(published_at, created_at)) / 86400 + 2, 1.2::float8)`

// regionMatch is a condition matching a LIKE pattern against the cities
// and/or provinces of trips (regions: "city", "province"). The stored ones
// come from the actual route, so for ongoing trips whose progress viewer may
// not see (service.Access.HideLive) only the planned stops are searched, as
// their cards show (see maskLive): matching a city the travellers checked in
// at unplanned would reveal where they are.
func regionMatch(db *gorm.DB, viewer *model.User, like string, regions ...string) clause.Expression {
	stored, planned := make([]string, len(regions)), make([]string, len(regions))
	for i, r := range regions {
		col := map[string]string{"city": "cities", "province": "provinces"}[r]
		stored[i] = "trips." + col + "::text ILIKE @like"
		planned[i] = "w." + r + " ILIKE @like"
	}
	storedSQL := "(" + strings.Join(stored, " OR ") + ")"
	if viewer != nil && viewer.IsAdmin() {
		return clause.NamedExpr{SQL: storedSQL, Vars: []any{sql.Named("like", like)}}
	}
	hidden := "trips.phase = @ongoing AND NOT trips.live_share"
	args := []any{sql.Named("like", like), sql.Named("ongoing", model.PhaseOngoing)}
	if viewer != nil {
		hidden += " AND trips.id NOT IN (@mine)"
		args = append(args, sql.Named("mine", service.AccessibleTripIDs(db, viewer.ID)))
	}
	return clause.NamedExpr{SQL: "(CASE WHEN " + hidden + " THEN EXISTS (SELECT 1 FROM waypoints w WHERE w.trip_id = trips.id AND w.planned AND (" +
		strings.Join(planned, " OR ") + ")) ELSE " + storedSQL + " END)", Vars: args}
}

func (h *Handler) listTrips(c *gin.Context) error {
	db := h.db.WithContext(c.Request.Context())
	viewer := currentUser(c)
	q := db.Model(&model.Trip{}).Where("visibility = ? AND status = ?", model.VisPublic, model.TripNormal)
	if kw := strings.TrimSpace(c.Query("q")); kw != "" {
		like := escapeLike(kw)
		q = q.Where("(title ILIKE ? OR summary ILIKE ? OR tags::text ILIKE ? OR ?)",
			like, like, like, regionMatch(db, viewer, like, "city", "province"))
	}
	if tag := strings.TrimSpace(c.Query("tag")); tag != "" {
		q = q.Where("tags @> ?::jsonb", jsonArray(tag))
	}
	if p := strings.TrimSpace(c.Query("province")); p != "" {
		q = q.Where(regionMatch(db, viewer, escapeLike(p), "province"))
	}
	if city := strings.TrimSpace(c.Query("city")); city != "" {
		q = q.Where(regionMatch(db, viewer, escapeLike(city), "city"))
	}
	if p := c.Query("phase"); p != "" {
		if !validPhase(p) {
			return errBad("phase 参数无效")
		}
		q = q.Where("phase = ?", p)
	}
	// Public trips always have published_at (set by createTrip / updateTrip /
	// the admin review), so no NULLS LAST: idx_trips_listing (visibility,
	// status, published_at) is then scanned backward instead of sorting all trips.
	order := "published_at DESC, id DESC"
	switch c.DefaultQuery("tab", "latest") {
	case "latest", "":
	case "featured":
		q = q.Where("featured")
		order = "featured_at DESC NULLS LAST, id DESC"
	case "hot":
		order = hotScoreSQL + " DESC, published_at DESC NULLS LAST, id DESC"
	case "following":
		if viewer == nil {
			return errLoginRequired
		}
		q = q.Where("owner_id IN (SELECT followee_id FROM follows WHERE follower_id = ?)", viewer.ID)
	default:
		return errBad("tab 参数无效")
	}
	return h.respondTripPage(c, q, order)
}

func jsonArray(s string) string {
	b, _ := json.Marshal([]string{s})
	return string(b)
}

// maxTripDays bounds a trip's planned days (a year, as its dates).
const maxTripDays = 365

// tripInput is the create/update request body.
type tripInput struct {
	Title      *string     `json:"title"`
	Summary    *string     `json:"summary"`
	Content    *string     `json:"content"`
	CoverURL   *string     `json:"cover_url"`
	Phase      *string     `json:"phase"`
	Visibility *string     `json:"visibility"`
	StartDate  Opt[string] `json:"start_date"`
	EndDate    Opt[string] `json:"end_date"`
	Tags       *[]string   `json:"tags"`
	LiveShare  *bool       `json:"live_share"`
	// WithPartner (creating only): the author's partner (couple space)
	// becomes a co-author, and the trip joins the couple space unless
	// SpaceID names one.
	WithPartner bool `json:"with_partner"`
	// SpaceID links the trip to a space the author belongs to (null or 0:
	// none); see createTrip and updateTrip. PUT /trips/:id/plan ignores it.
	SpaceID Opt[int64] `json:"space_id"`
	// Days planned (0 clears): with a start date it sets the end date.
	Days       Opt[int] `json:"days"`
	TravelMode *string  `json:"travel_mode"`
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
	switch {
	case in.Days.Set && !in.Days.Null:
		n := in.Days.V
		if n < 0 || n > maxTripDays {
			return nil, errBad(fmt.Sprintf("天数范围为 1–%d 天", maxTripDays))
		}
		if n > 0 && t.StartDate != nil { // the dates follow the days
			end := t.StartDate.AddDate(0, 0, n-1)
			if in.EndDate.Set && t.EndDate != nil && !t.EndDate.Equal(end) {
				return nil, errBad("天数与起止日期不一致")
			}
			t.EndDate, upd["end_date"] = &end, &end
		}
		t.PlanDays, upd["plan_days"] = n, n
	case in.Days.Null:
		t.PlanDays, upd["plan_days"] = 0, 0
	case (in.StartDate.Set || in.EndDate.Set) && t.StartDate != nil && t.EndDate != nil:
		// The days follow the dates, and stay when the dates are cleared later.
		if n := service.DateSpan(t.StartDate, t.EndDate); n > 0 && n <= maxTripDays {
			t.PlanDays, upd["plan_days"] = n, n
		}
	}
	if in.TravelMode != nil {
		m := strings.TrimSpace(*in.TravelMode)
		if m == "" {
			m = model.TravelAuto
		}
		if !slices.Contains(model.TravelModes, m) {
			return nil, errBad("travel_mode 只能是 auto / walking / riding / driving / transit")
		}
		t.TravelMode, upd["travel_mode"] = m, m
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
	if in.LiveShare != nil {
		t.LiveShare, upd["live_share"] = *in.LiveShare, *in.LiveShare
	}
	return upd, nil
}

// screenedTexts returns the user-written texts of t that in sets, for
// Handler.screen (each tag on its own).
func (in *tripInput) screenedTexts(t *model.Trip) []string {
	var out []string
	if in.Title != nil {
		out = append(out, t.Title)
	}
	if in.Summary != nil {
		out = append(out, t.Summary)
	}
	if in.Content != nil {
		out = append(out, t.Content)
	}
	if in.Tags != nil {
		out = append(out, t.Tags...)
	}
	return out
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

// createTripRecord inserts a trip (with a unique share code) and its owner
// row. A new trip is at revision 1, made by its owner.
func createTripRecord(tx *gorm.DB, t *model.Trip) error {
	t.Revision, t.UpdatedByID = 1, t.OwnerID
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
		Tags: []string{}, Cities: []string{}, Provinces: []string{}, TravelMode: model.TravelAuto}
	if _, err := in.apply(&t, true); err != nil {
		return err
	}
	if err := h.screen(c, in.screenedTexts(&t)...); err != nil {
		return err
	}
	if t.Visibility == model.VisPublic && h.svc.Settings.Get().ReviewPublicTrips && !u.IsAdmin() {
		t.Status = model.TripPending // public once an admin approves it
	}
	t.Days = service.TripDays(t.StartDate, t.EndDate, t.PlanDays, nil, h.loc)
	now := time.Now()
	if t.Visibility == model.VisPublic {
		t.PublishedAt = &now
	}
	ctx := c.Request.Context()
	err := h.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var spaceID, partnerID int64
		if in.SpaceID.Set && !in.SpaceID.Null {
			spaceID = in.SpaceID.V
		}
		if in.WithPartner {
			pid, couple, err := service.PartnerOf(tx, u.ID)
			if err != nil {
				return err
			}
			if pid != 0 {
				partnerID = pid
				if spaceID == 0 {
					spaceID = couple.ID
				}
			}
		}
		if spaceID != 0 {
			// The space is locked before the trip exists (spaces before trips).
			if err := linkableSpace(tx, spaceID, u.ID); err != nil {
				return err
			}
			t.SpaceID = &spaceID
		}
		if err := createTripRecord(tx, &t); err != nil {
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
		if err := h.svc.AwardExp(tx, u.ID, service.ExpKey("trip_create", t.ID), service.ExpCreateTrip, "trip_create"); err != nil {
			return err
		}
		if t.Visibility == model.VisPublic && t.Status == model.TripNormal {
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

// tripUpdate is a validated change of a trip's own fields, as PATCH
// /trips/:id and PUT /trips/:id/plan write it.
type tripUpdate struct {
	t   *model.Trip    // the trip with the change applied
	upd map[string]any // the columns to write; empty: nothing changes
	// The trip as it was.
	oldVis, oldPhase string
	oldLive          bool
	oldDays          int
	firstPublic      bool // published for the first time
	datesChanged     bool // dates or planned days: days may shrink (service.ShrinkDays)
}

// prepareTripUpdate validates in for viewer a and applies it to t (as
// loaded; it is changed): owner-only fields, the fields themselves,
// sensitive words, and the review of public trips.
func (h *Handler) prepareTripUpdate(c *gin.Context, t *model.Trip, a service.Access, in *tripInput) (*tripUpdate, error) {
	tu := &tripUpdate{t: t, oldVis: t.Visibility, oldPhase: t.Phase, oldLive: t.LiveShare, oldDays: t.Days}
	before := *t
	if in.Visibility != nil && *in.Visibility != t.Visibility && !a.Owner {
		return nil, errForbidden("只有作者可以修改可见性")
	}
	if in.LiveShare != nil && *in.LiveShare != t.LiveShare && !a.Owner {
		return nil, errForbidden("只有作者可以修改实时位置公开设置")
	}
	upd, err := in.apply(t, false)
	if err != nil {
		return nil, err
	}
	if err := h.screen(c, in.screenedTexts(t)...); err != nil {
		return nil, err
	}
	// Review of public trips (a site setting): a trip a non-admin makes public
	// waits for an admin, one that is no longer public leaves the queue.
	// Hidden trips stay hidden, also when an admin hides one meanwhile.
	setStatus := func(from, to string) {
		t.Status, upd["status"] = to, gorm.Expr("CASE WHEN status = ? THEN ? ELSE status END", from, to)
	}
	switch {
	case tu.oldVis != model.VisPublic && t.Visibility == model.VisPublic && t.Status == model.TripNormal &&
		h.svc.Settings.Get().ReviewPublicTrips && !currentUser(c).IsAdmin():
		setStatus(model.TripNormal, model.TripPending)
	case t.Status == model.TripPending && t.Visibility != model.VisPublic:
		setStatus(model.TripPending, model.TripNormal)
	}
	tu.firstPublic = t.Visibility == model.VisPublic && t.PublishedAt == nil
	if !tu.firstPublic && !tripFieldsChanged(&before, t) {
		upd = map[string]any{} // the values it has already (e.g. a whole form sent back): nothing to write
	}
	tu.upd = upd
	if len(upd) == 0 {
		return tu, nil
	}
	if tu.firstPublic {
		upd["published_at"] = time.Now()
	}
	for _, col := range []string{"start_date", "end_date", "plan_days"} {
		if _, ok := upd[col]; ok {
			tu.datesChanged = true
		}
	}
	return tu, nil
}

// tripFieldsChanged reports whether a trip's fields that tripInput and the
// review of public trips set differ between a and b.
func tripFieldsChanged(a, b *model.Trip) bool {
	sameDate := func(x, y *time.Time) bool { return x == nil && y == nil || x != nil && y != nil && x.Equal(*y) }
	return a.Title != b.Title || a.Summary != b.Summary || a.Content != b.Content || a.CoverURL != b.CoverURL ||
		a.Phase != b.Phase || a.Visibility != b.Visibility || a.Status != b.Status || !sameDate(a.StartDate, b.StartDate) ||
		!sameDate(a.EndDate, b.EndDate) || a.PlanDays != b.PlanDays || a.TravelMode != b.TravelMode ||
		!slices.Equal(a.Tags, b.Tags) || a.LiveShare != b.LiveShare
}

// finishTripUpdate follows up a trip update written in tx (the caller holds
// the trip lock when tu.datesChanged): the waypoints of days that no longer
// exist move (service.ShrinkDays), the statistics of the trip's places
// follow its visibility, phase and live sharing, and the first publication
// earns experience. The caller then recomputes the trip (RecomputeTrip)
// when its dates or days changed.
func (h *Handler) finishTripUpdate(tx *gorm.DB, tu *tripUpdate) error {
	t := tu.t
	if tu.datesChanged {
		days := service.DateSpan(t.StartDate, t.EndDate)
		if days == 0 {
			days = t.PlanDays
		}
		if days > 0 && days < tu.oldDays {
			ids, err := service.ShrinkDays(tx, t.ID, days)
			if err != nil {
				return err
			}
			if err := h.svc.RecomputePlaces(tx, ids); err != nil {
				return err
			}
		}
	}
	// Place statistics count public trips, ongoing ones only with live
	// sharing (see service.RecomputePlaces).
	if tu.oldVis != t.Visibility || tu.oldPhase != t.Phase || tu.oldLive != t.LiveShare {
		ids, err := service.TripPlaceIDs(tx, t.ID)
		if err != nil {
			return err
		}
		if err := h.svc.RecomputePlaces(tx, ids); err != nil {
			return err
		}
	}
	if tu.firstPublic && t.Status == model.TripNormal { // a pending trip earns it when approved
		return h.svc.AwardExp(tx, t.OwnerID, service.ExpKey("trip_public", t.ID), service.ExpFirstPublic, "trip_public")
	}
	return nil
}

// linkableSpace share-locks space spaceID (service.ShareLockSpace) for a
// trip to be linked to it by userID, who must be a member (404 otherwise):
// neither the space nor the membership can go before the transaction ends.
func linkableSpace(tx *gorm.DB, spaceID, userID int64) error {
	sp, err := service.ShareLockSpace(tx, spaceID)
	if err != nil {
		return err
	}
	if sp == nil {
		return errSpaceNotFound
	}
	m, err := service.SpaceMembership(tx, spaceID, userID)
	if err != nil {
		return err
	}
	if m == nil {
		return errSpaceNotFound
	}
	return nil
}

// spaceChange is the change of a trip's space a PATCH /trips/:id asks for:
// link it to a space (to), or unlink it (to 0).
type spaceChange struct {
	change bool
	to     int64
}

// tripSpaceChange reads the change of trip t's space in in, checking what
// may be checked before the transaction: only the trip's author links it
// to a space (one they belong to, checked by linkSpace); the author or the
// space's owner unlinks it.
func tripSpaceChange(t *model.Trip, a service.Access, in *tripInput) (spaceChange, error) {
	if !in.SpaceID.Set {
		return spaceChange{}, nil
	}
	to := int64(0)
	if !in.SpaceID.Null {
		to = in.SpaceID.V
	}
	from := int64(0)
	if t.SpaceID != nil {
		from = *t.SpaceID
	}
	if to == from {
		return spaceChange{}, nil
	}
	if to != 0 && !a.Owner {
		return spaceChange{}, errForbidden("只有作者可以把旅程加入空间")
	}
	return spaceChange{change: true, to: to}, nil
}

// linkSpace applies sc to trip t (as loaded) for the current user in tx,
// before any trip is locked (spaces are locked before trips), and returns
// the column value to write. The trip must still be in the space it was
// loaded with.
func linkSpace(tx *gorm.DB, c *gin.Context, t *model.Trip, a service.Access, sc spaceChange) (any, error) {
	me := currentUserID(c)
	if sc.to != 0 {
		if err := linkableSpace(tx, sc.to, me); err != nil {
			return nil, err
		}
	} else if !a.Owner {
		sp, err := service.ShareLockSpace(tx, *t.SpaceID)
		if err != nil {
			return nil, err
		}
		if sp == nil || sp.OwnerID != me {
			return nil, errForbidden("只有作者或空间的创建者可以把旅程移出空间")
		}
	}
	if err := service.LockTrip(tx, t.ID); err != nil {
		return nil, err
	}
	var cur model.Trip
	if err := tx.Select("id", "space_id").Limit(1).Find(&cur, t.ID).Error; err != nil {
		return nil, err
	}
	if cur.ID == 0 {
		return nil, errTripNotFound
	}
	if (cur.SpaceID == nil) != (t.SpaceID == nil) || (cur.SpaceID != nil && *cur.SpaceID != *t.SpaceID) {
		return nil, errConflict("旅程所属的空间刚被修改，请刷新后重试")
	}
	if t.SpaceID != nil {
		// The members of the space it leaves who added to it keep it.
		if err := service.KeepContributors(tx, *t.SpaceID, []int64{t.ID}, sc.to); err != nil {
			return nil, err
		}
	}
	if sc.to == 0 {
		return gorm.Expr("NULL"), nil
	}
	return sc.to, nil
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
	sc, err := tripSpaceChange(t, a, &in)
	if err != nil {
		return err
	}
	tu, err := h.prepareTripUpdate(c, t, a, &in)
	if err != nil {
		return err
	}
	if len(tu.upd) == 0 && !sc.change {
		return h.respondTripDetail(c, t.ID)
	}
	err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		if sc.change {
			v, err := linkSpace(tx, c, t, a, sc)
			if err != nil {
				return err
			}
			tu.upd["space_id"] = v
		}
		if tu.datesChanged { // days may shrink: waypoints move (see service.ShrinkDays)
			if err := service.LockTrip(tx, t.ID); err != nil {
				return err
			}
		}
		if err := tx.Model(&model.Trip{}).Where("id = ?", t.ID).Updates(tu.upd).Error; err != nil {
			return err
		}
		if err := h.finishTripUpdate(tx, tu); err != nil {
			return err
		}
		if tu.datesChanged {
			if err := h.svc.RecomputeTrip(tx, t.ID); err != nil {
				return err
			}
		}
		_, err := service.TouchTrip(tx, t.ID, currentUserID(c))
		return err
	})
	if err != nil {
		return err
	}
	err = h.respondTripDetail(c, t.ID)
	if err == errTripNotFound && sc.change && !a.Owner {
		// The space's owner took someone else's trip out of the space, and
		// with it their own access to it: there is nothing to show them.
		c.JSON(http.StatusOK, gin.H{})
		return nil
	}
	return err
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
	src, a, err := h.tripForView(c)
	if err != nil {
		return err
	}
	var req struct {
		Title        string `json:"title"`
		IncludeAvoid bool   `json:"include_avoid"` // also copy stops the author marked 踩雷
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	title, err := clean(req.Title, "标题", 100, false)
	if err != nil {
		return err
	}
	if err := h.screen(c, title); err != nil {
		return err
	}
	if title == "" {
		title = service.Truncate(src.Title, 95)
	}
	u := currentUser(c)
	srcID := src.ID
	nt := model.Trip{OwnerID: u.ID, Title: title, Summary: src.Summary, Phase: model.PhasePlanning,
		Visibility: model.VisPrivate, Status: model.TripNormal, Tags: nonNil(src.Tags), Cities: []string{}, Provinces: []string{},
		ForkedFromID: &srcID, PlanDays: src.Days, TravelMode: src.TravelMode}
	if nt.TravelMode == "" {
		nt.TravelMode = model.TravelAuto
	}
	err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		if err := createTripRecord(tx, &nt); err != nil {
			return err
		}
		q := tx.Where("trip_id = ?", src.ID)
		hide := a.HideLive(src)
		if hide {
			// The plan as planned: unplanned stops and skips are live progress (see redactLive).
			q = q.Where("planned")
		} else {
			q = q.Where("status <> ?", model.WPSkipped)
			if !req.IncludeAvoid { // a 踩雷 stop must not become a planned stop of the copy
				q = q.Where("verdict <> ?", model.VerdictAvoid)
			}
		}
		var wps []model.Waypoint
		if err := q.Order("seq, id").Find(&wps).Error; err != nil {
			return err
		}
		if hide { // the days as planned (the stored ones may count arrival dates)
			nt.PlanDays = service.TripPlanStats(src.StartDate, src.EndDate, src.PlanDays, wps, h.loc).Days
			if err := tx.Model(&model.Trip{}).Where("id = ?", nt.ID).Update("plan_days", nt.PlanDays).Error; err != nil {
				return err
			}
		}
		copies := make([]model.Waypoint, 0, len(wps))
		for i, w := range wps {
			// Verdicts are not copied (they would be the copier's reviews), but a
			// 踩雷 copied on request keeps its warning in the note.
			note := w.Note
			if w.Verdict == model.VerdictAvoid && !hide {
				note = "⚠️ 原作者标记为踩雷"
				if w.Note != "" {
					note = "⚠️ 原作者踩雷：" + w.Note
				}
			}
			kind := w.Kind
			if kind == "" {
				kind = model.KindStop
			}
			copies = append(copies, model.Waypoint{
				TripID: nt.ID, Seq: i, Day: w.Day, Kind: kind, Planned: true, Status: model.WPTodo,
				Name: w.Name, Address: w.Address, Province: w.Province, ProvinceCode: w.ProvinceCode,
				City: w.City, CityCode: w.CityCode, District: w.District, Lng: w.Lng, Lat: w.Lat,
				Category: w.Category, Note: note, Cost: w.Cost, AmapID: w.AmapID, PlaceID: w.PlaceID,
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
		if err := service.RecomputeForkCount(tx, src.ID); err != nil {
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
	t, a, err := h.tripForView(c)
	if err != nil {
		return 0, nil, err
	}
	// Only what GET /me/favorites lists (public and normal, or the user's own
	// trips): a favourite of an unlisted trip would vanish from that list.
	// Removing one is always allowed.
	if table == "favorites" && on && !a.Member && !(t.Visibility == model.VisPublic && t.Status == model.TripNormal) {
		return 0, nil, errForbidden("只能收藏公开的旅程")
	}
	u := currentUser(c)
	counter := map[string]string{"likes": "like_count", "favorites": "fav_count"}[table]
	var count int
	err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		// Lock first: under READ COMMITTED the recount below would otherwise
		// miss rows of a concurrent like that commits while we wait for the row.
		if err := service.LockTrip(tx, t.ID); err != nil {
			return err
		}
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
		err := db.Transaction(func(tx *gorm.DB) error {
			if err := tx.Model(&model.Trip{}).Where("id = ?", t.ID).UpdateColumn("share_code", code).Error; err != nil {
				return err
			}
			_, err := service.TouchTrip(tx, t.ID, currentUserID(c))
			return err
		})
		if err == nil {
			c.JSON(http.StatusOK, gin.H{"share_code": code})
			return nil
		}
		if !errors.Is(err, gorm.ErrDuplicatedKey) || attempt >= 3 {
			return err
		}
	}
}
