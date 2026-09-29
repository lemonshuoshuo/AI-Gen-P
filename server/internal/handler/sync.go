package handler

import (
	"cmp"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"triphub/internal/model"
	"triphub/internal/service"
)

// Collaborative editing: members editing a trip at the same time keep in
// sync through the trip's revision (model.Trip.Revision, counted by every
// change): the editor polls GET /trips/:id/revision, reloads the trip when
// it moved on, and saves its draft with PUT /trips/:id/plan, which only
// applies onto the revision the draft was based on (or overwrites, when
// forced). Heartbeats (POST /trips/:id/editing) tell who else is editing.

// presenceTTL is how long a member counts as editing a trip after their last
// heartbeat (POST /trips/:id/editing); clients send one every 15–20 s.
const presenceTTL = 45 * time.Second

// maxPresence bounds the editors recorded (all trips together); beyond it
// new ones are not recorded until others expire.
const maxPresence = 20000

// editorEntry is a member editing a trip.
type editorEntry struct {
	user  UserBrief
	since time.Time // first heartbeat of this editing session
	seen  time.Time // last heartbeat
}

// presence records who has a trip's editor open, from their heartbeats. It
// lives in this process only (TripHub runs as a single instance; with
// several, each would know the editors whose heartbeats it received).
type presence struct {
	mu    sync.Mutex
	ttl   time.Duration
	trips map[int64]map[int64]*editorEntry // trip → user → entry
	n     int                              // entries in trips
}

func newPresence(ttl time.Duration) *presence {
	return &presence{ttl: ttl, trips: map[int64]map[int64]*editorEntry{}}
}

// beat records a heartbeat of user u in trip tripID at now.
func (p *presence) beat(tripID int64, u UserBrief, now time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	eds := p.trips[tripID]
	e := eds[u.ID]
	switch {
	case e != nil && now.Sub(e.seen) <= p.ttl:
		e.user, e.seen = u, now
	case e != nil: // expired meanwhile: a new editing session
		e.user, e.since, e.seen = u, now, now
	case p.n < maxPresence:
		if eds == nil {
			eds = map[int64]*editorEntry{}
			p.trips[tripID] = eds
		}
		eds[u.ID] = &editorEntry{user: u, since: now, seen: now}
		p.n++
	}
}

// leave removes user userID from the editors of trip tripID.
func (p *presence) leave(tripID, userID int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if eds := p.trips[tripID]; eds[userID] != nil {
		delete(eds, userID)
		p.n--
		if len(eds) == 0 {
			delete(p.trips, tripID)
		}
	}
}

// editors lists who is editing trip tripID at now, earliest first,
// forgetting those whose last heartbeat is older than the TTL.
func (p *presence) editors(tripID int64, now time.Time) []editorEntry {
	p.mu.Lock()
	defer p.mu.Unlock()
	eds := p.trips[tripID]
	out := make([]editorEntry, 0, len(eds))
	for id, e := range eds {
		if now.Sub(e.seen) > p.ttl {
			delete(eds, id)
			p.n--
			continue
		}
		out = append(out, *e)
	}
	if eds != nil && len(eds) == 0 {
		delete(p.trips, tripID)
	}
	slices.SortFunc(out, func(a, b editorEntry) int {
		return cmp.Or(a.since.Compare(b.since), cmp.Compare(a.user.ID, b.user.ID))
	})
	return out
}

// cleanup forgets every expired heartbeat.
func (p *presence) cleanup(now time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for tripID, eds := range p.trips {
		for id, e := range eds {
			if now.Sub(e.seen) > p.ttl {
				delete(eds, id)
				p.n--
			}
		}
		if len(eds) == 0 {
			delete(p.trips, tripID)
		}
	}
}

// editorDTO is a member editing a trip.
type editorDTO struct {
	User     UserBrief `json:"user"`
	Since    string    `json:"since"`
	LastSeen string    `json:"last_seen"`
}

// revisionDTO is the answer of GET /trips/:id/revision and POST
// /trips/:id/editing.
type revisionDTO struct {
	Revision  int64       `json:"revision"`
	UpdatedAt string      `json:"updated_at"`
	UpdatedBy *UserBrief  `json:"updated_by"`
	Editors   []editorDTO `json:"editors"`
}

// revisionBody describes trip t's revision to viewer a; by made its last
// change (nil: unknown). Who changed it and who is editing are for the
// trip's members (invitees too) and admins only. Viewers who may not see an
// ongoing trip's progress get revision 0 and its creation time, as on its
// cards (maskLive): its changes would tell when the travellers were active.
func (h *Handler) revisionBody(t *model.Trip, a service.Access, by *model.User) revisionDTO {
	if a.HideLive(t) {
		return revisionDTO{UpdatedAt: h.ts(t.CreatedAt), Editors: []editorDTO{}}
	}
	out := revisionDTO{Revision: t.Revision, UpdatedAt: h.ts(t.UpdatedAt), Editors: []editorDTO{}}
	if !a.Member && !a.Pending && !a.Admin {
		return out
	}
	out.UpdatedBy = userBrief(by)
	for _, e := range h.presence.editors(t.ID, time.Now()) {
		out.Editors = append(out.Editors, editorDTO{User: e.user, Since: h.ts(e.since), LastSeen: h.ts(e.seen)})
	}
	return out
}

// tripRevision is GET /trips/:id/revision, polled by open editors and trip
// pages: the trip's revision, who made the last change and who is editing
// it. Visible like the trip itself (share codes accepted); a single query
// besides authentication.
func (h *Handler) tripRevision(c *gin.Context) error {
	id, err := idParam(c, "id")
	if err != nil {
		return err
	}
	u := currentUser(c)
	var uid int64
	if u != nil {
		uid = u.ID
	}
	var row struct {
		ID, OwnerID, Revision                int64
		Visibility, Status, Phase, ShareCode string
		LiveShare                            bool
		CreatedAt, UpdatedAt                 time.Time
		SpaceID                              *int64
		MemberStatus                         *string
		InSpace                              bool
		ByID                                 *int64
		ByUsername, ByNickname, ByAvatarURL  *string
		ByRole                               *string
		ByExp                                *int
	}
	if err := h.db.WithContext(c.Request.Context()).Raw(`SELECT t.id, t.owner_id, t.revision, t.visibility, t.status,
  t.phase, t.share_code, t.live_share, t.created_at, t.updated_at, t.space_id, m.status AS member_status,
  (t.space_id IS NOT NULL AND EXISTS (SELECT 1 FROM space_members sm WHERE sm.space_id = t.space_id AND sm.user_id = ?)) AS in_space,
  u.id AS by_id, u.username AS by_username, u.nickname AS by_nickname, u.avatar_url AS by_avatar_url,
  u.role AS by_role, u.exp AS by_exp
FROM trips t
LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ?
LEFT JOIN users u ON u.id = t.updated_by_id
WHERE t.id = ?`, uid, uid, id).Scan(&row).Error; err != nil {
		return err
	}
	if row.ID == 0 {
		return errTripNotFound
	}
	t := model.Trip{ID: row.ID, OwnerID: row.OwnerID, Revision: row.Revision, Visibility: row.Visibility, Status: row.Status,
		Phase: row.Phase, ShareCode: row.ShareCode, LiveShare: row.LiveShare, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
		SpaceID: row.SpaceID}
	a := service.AccessFrom(&t, u, shareCodeFrom(c), deref(row.MemberStatus), row.InSpace)
	if !a.CanView(&t) {
		return errTripNotFound
	}
	var by *model.User
	if row.ByID != nil {
		by = &model.User{ID: *row.ByID, Username: deref(row.ByUsername), Nickname: deref(row.ByNickname),
			AvatarURL: deref(row.ByAvatarURL), Role: deref(row.ByRole)}
		if row.ByExp != nil {
			by.Exp = *row.ByExp
		}
	}
	c.JSON(http.StatusOK, h.revisionBody(&t, a, by))
	return nil
}

func deref[T any](p *T) T {
	var v T
	if p != nil {
		v = *p
	}
	return v
}

// lastEditor loads the user who made trip t's last change (nil: unknown).
func (h *Handler) lastEditor(c *gin.Context, t *model.Trip) (*model.User, error) {
	if t.UpdatedByID == 0 {
		return nil, nil
	}
	users, err := h.loadUsers(c.Request.Context(), []int64{t.UpdatedByID})
	if err != nil {
		return nil, err
	}
	return users[t.UpdatedByID], nil
}

// tripEditing is POST /trips/:id/editing {active}: a member's heartbeat
// while the trip's editor is open (active, the default), or leaving it
// (active=false). It answers like GET /trips/:id/revision.
func (h *Handler) tripEditing(c *gin.Context) error {
	t, a, err := h.tripForEdit(c)
	if err != nil {
		return err
	}
	var req struct {
		Active *bool `json:"active"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	u := currentUser(c)
	if req.Active == nil || *req.Active {
		h.presence.beat(t.ID, *userBrief(u), time.Now())
	} else {
		h.presence.leave(t.ID, u.ID)
	}
	by, err := h.lastEditor(c, t)
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, h.revisionBody(t, a, by))
	return nil
}

// revisionConflict refuses a plan drafted on an older revision of the trip
// (PUT /trips/:id/plan without force); trip is the trip as it is now.
type revisionConflict struct{ trip *model.Trip }

func (e *revisionConflict) Error() string { return "conflict: the trip has changed" }

// respondConflict answers 409 for a draft of trip t (as it is now) based on
// an older revision, saying who changed the trip and when.
func (h *Handler) respondConflict(c *gin.Context, t *model.Trip) error {
	by, err := h.lastEditor(c, t)
	if err != nil {
		return err
	}
	msg := "行程已被修改"
	switch {
	case by != nil && by.ID == currentUserID(c):
		msg = "行程已在你的其他页面或设备上修改"
	case by != nil:
		msg = "行程已被 " + userBrief(by).Nickname + " 修改"
	}
	c.JSON(http.StatusConflict, gin.H{
		"error":    gin.H{"code": "conflict", "message": msg},
		"revision": t.Revision, "updated_by": userBrief(by), "updated_at": h.ts(t.UpdatedAt),
	})
	return nil
}

// planItemError is an error of the index-th waypoint of a plan: its message
// names it (第 N 项) and the answer carries the index.
type planItemError struct {
	err   *apiError
	index int
}

func (e *planItemError) Error() string { return e.err.Error() }
func (e *planItemError) Unwrap() error { return e.err }

// itemError attributes err to the i-th waypoint of a plan.
func itemError(i int, err error) error {
	var ae *apiError
	if !errors.As(err, &ae) {
		return err
	}
	return &planItemError{&apiError{ae.Status, ae.Code, fmt.Sprintf("第 %d 项：%s", i+1, ae.Message)}, i}
}

// maxPlanWaypoints bounds the waypoints of one PUT /trips/:id/plan.
const maxPlanWaypoints = 1000

// planItem is a waypoint of PUT /trips/:id/plan: an existing one (id) to
// update, or a new planned stop or lodging (no id). client_key names it in
// the answer's id_map. The fields are those of PATCH /waypoints/:id, absent
// ones staying as they are; status, planned and arrived_at (check-ins,
// which a plan never undoes) and seq (the list's order is the order) are
// ignored.
type planItem struct {
	waypointInput
	ID        *int64 `json:"id"`
	ClientKey string `json:"client_key"`
}

// planRequest is the body of PUT /trips/:id/plan.
type planRequest struct {
	BaseRevision *int64      `json:"base_revision"`
	Force        bool        `json:"force"`
	Trip         *tripInput  `json:"trip"`
	Waypoints    *[]planItem `json:"waypoints"`
}

// planWaypoint is an item of a plan prepared for saving.
type planWaypoint struct {
	key     string
	in      *waypointInput
	orig    *model.Waypoint // the waypoint as loaded before the transaction; nil: new
	cur     *model.Waypoint // the waypoint under the trip lock; nil: to be created
	wp      model.Waypoint  // the waypoint as the item wants it
	ch      wpChange
	missing int64 // an id not in the trip (without force: a conflict, or an error)
}

// savePlan is PUT /trips/:id/plan: the whole plan of a trip, drafted in the
// editor, saved at once. waypoints is the complete list of the trip's
// planned waypoints (stops and lodging) in the order wanted: listed ones are
// updated, new ones created, and planned ones left out deleted, except
// those with history (visited, or with photos), which are kept and
// reported (kept). Unplanned waypoints (unplanned check-ins) are no part of
// the plan: they stay, after the waypoint they followed. A draft based on
// an older revision is refused (409) unless forced, then it overwrites.
// Everything is written in one transaction under the trip lock, counting
// one revision.
func (h *Handler) savePlan(c *gin.Context) error {
	err := h.writePlanRequest(c)
	var itemErr *planItemError
	if errors.As(err, &itemErr) { // the message names the waypoint; the index too
		c.JSON(itemErr.err.Status, gin.H{"error": gin.H{"code": itemErr.err.Code, "message": itemErr.err.Message},
			"index": itemErr.index})
		return nil
	}
	return err
}

// writePlanRequest does the work of savePlan.
func (h *Handler) writePlanRequest(c *gin.Context) error {
	t, a, err := h.tripForEdit(c)
	if err != nil {
		return err
	}
	var req planRequest
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	if req.Waypoints == nil {
		return errBad("缺少 waypoints（完整的计划列表）")
	}
	if req.BaseRevision == nil && !req.Force {
		return errBad("缺少 base_revision（草稿所基于的旅程版本）")
	}
	items := *req.Waypoints
	if len(items) > maxPlanWaypoints {
		return errBad(fmt.Sprintf("单次最多保存 %d 个地点", maxPlanWaypoints))
	}
	// A stale draft is refused before any work (and again under the lock).
	if !req.Force && *req.BaseRevision != t.Revision {
		return h.respondConflict(c, t)
	}
	uid := currentUserID(c)
	ctx := c.Request.Context()
	db := h.db.WithContext(ctx)

	// The trip's own fields: validated now, applied under the lock to the
	// trip as it is then.
	draft := *t
	if req.Trip != nil {
		if _, err := h.prepareTripUpdate(c, &draft, a, req.Trip); err != nil {
			return err
		}
	}
	var loaded []model.Waypoint
	if err := db.Where("trip_id = ?", t.ID).Order("seq, id").Find(&loaded).Error; err != nil {
		return err
	}
	byID := make(map[int64]*model.Waypoint, len(loaded))
	for i := range loaded {
		byID[loaded[i].ID] = &loaded[i]
	}
	prep := make([]planWaypoint, len(items))
	seenID, seenKey := map[int64]bool{}, map[string]bool{}
	for i := range items {
		it := &items[i]
		// Check-ins are not the plan's: a draft never changes them.
		it.Status, it.Planned, it.ArrivedAt, it.Seq = nil, nil, Opt[string]{}, nil
		p := &prep[i]
		p.in, p.key = &it.waypointInput, strings.TrimSpace(it.ClientKey)
		if len(p.key) > 64 {
			return itemError(i, errBad("client_key 不能超过 64 个字符"))
		}
		if p.key != "" {
			if seenKey[p.key] {
				return itemError(i, errBad("client_key 重复"))
			}
			seenKey[p.key] = true
		}
		if it.ID != nil && *it.ID != 0 {
			if seenID[*it.ID] {
				return itemError(i, errBad("同一个地点在列表中出现了两次"))
			}
			seenID[*it.ID] = true
			if o := byID[*it.ID]; o != nil {
				p.orig, p.wp = o, *o
				if p.ch, err = h.applyWaypoint(c, &draft, &p.wp, p.in, false); err != nil {
					return itemError(i, err)
				}
				continue
			}
			if !req.Force {
				p.missing = *it.ID
				continue
			}
			// Forced: a waypoint deleted meanwhile is created again, as drafted.
		}
		planned := true
		p.in.Planned = &planned
		p.wp = model.Waypoint{TripID: t.ID, CreatedByID: uid}
		if p.ch, err = h.applyWaypoint(c, &draft, &p.wp, p.in, true); err != nil {
			return itemError(i, err)
		}
	}
	// Place details of new and moved waypoints, before taking the lock
	// (reverse geocoding may involve network calls).
	var wg sync.WaitGroup
	sem := make(chan struct{}, 5)
	for i := range prep {
		p := &prep[i]
		if p.missing != 0 || (p.orig != nil && !p.ch.coords && !p.ch.renamed && !p.ch.relink) {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if p.orig == nil || p.ch.coords || p.ch.renamed {
				h.locateWaypoint(ctx, &p.wp, p.ch, p.in)
			} else {
				h.svc.WarmPOI(ctx, p.wp.AmapID)
			}
		}()
	}
	wg.Wait()

	var sp *savedPlan
	err = db.Transaction(func(tx *gorm.DB) error {
		var err error
		sp, err = h.writePlan(tx, c, a, t.ID, &req, prep)
		return err
	})
	var conflict *revisionConflict
	if errors.As(err, &conflict) {
		return h.respondConflict(c, conflict.trip)
	}
	if err != nil {
		return err
	}
	saved, a, err := h.loadTrip(c, t.ID, "")
	if err != nil {
		return err
	}
	d, err := h.tripDetail(ctx, saved, a, currentUser(c))
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{"trip": d, "id_map": sp.idMap, "kept": sp.kept, "deleted": sp.deleted})
	return nil
}

// savedPlan is what writePlan did.
type savedPlan struct {
	idMap   map[string]int64 // client_key → waypoint ID
	kept    []int64          // planned waypoints left out but kept (history)
	deleted []int64          // planned waypoints left out and deleted
}

// writePlan saves a prepared plan (see savePlan) in tx.
func (h *Handler) writePlan(tx *gorm.DB, c *gin.Context, a service.Access, tripID int64, req *planRequest, prep []planWaypoint) (*savedPlan, error) {
	uid := currentUserID(c)
	sp := &savedPlan{idMap: map[string]int64{}, kept: []int64{}, deleted: []int64{}}
	if err := service.LockTrip(tx, tripID); err != nil {
		return nil, err
	}
	var trip model.Trip
	if err := tx.First(&trip, tripID).Error; err != nil {
		return nil, err
	}
	if !req.Force && trip.Revision != *req.BaseRevision {
		return nil, &revisionConflict{&trip}
	}
	for i := range prep {
		if prep[i].missing != 0 { // unchanged revision: the id was never in this trip
			return nil, itemError(i, errBad(fmt.Sprintf("地点 %d 不在这个旅程中，请刷新后重试", prep[i].missing)))
		}
	}
	changed := false
	var tu *tripUpdate
	if req.Trip != nil {
		var err error
		if tu, err = h.prepareTripUpdate(c, &trip, a, req.Trip); err != nil {
			return nil, err
		}
		if len(tu.upd) == 0 {
			tu = nil
		} else {
			if err := tx.Model(&model.Trip{}).Where("id = ?", tripID).Updates(tu.upd).Error; err != nil {
				return nil, err
			}
			changed = true
		}
	}

	var wps []model.Waypoint
	if err := tx.Where("trip_id = ?", tripID).Order("seq, id").Find(&wps).Error; err != nil {
		return nil, err
	}
	now := make(map[int64]*model.Waypoint, len(wps))
	for i := range wps {
		now[wps[i].ID] = &wps[i]
	}
	listed := map[int64]bool{}
	for i := range prep {
		p := &prep[i]
		if p.orig == nil {
			continue
		}
		if p.cur = now[p.orig.ID]; p.cur != nil {
			listed[p.cur.ID] = true
			continue
		}
		// Deleted since it was loaded (the save is forced, or the revision
		// would have changed): created again as drafted, a new planned
		// waypoint like those of new items.
		w := &p.wp
		w.ID, w.CreatedByID, w.ClientID, w.PlaceID = 0, uid, "", nil
		w.Planned, w.Status, w.ArrivedAt = true, model.WPTodo, nil
		w.CreatedAt, w.UpdatedAt = time.Time{}, time.Time{}
	}

	// Planned waypoints left out are deleted, except history: visited ones
	// and those with photos stay (kept). Unplanned ones are not in the plan.
	var photoWPs []int64
	if err := tx.Model(&model.Photo{}).Where("trip_id = ? AND waypoint_id IS NOT NULL", tripID).
		Distinct().Pluck("waypoint_id", &photoWPs).Error; err != nil {
		return nil, err
	}
	withPhotos := make(map[int64]bool, len(photoWPs))
	for _, id := range photoWPs {
		withPhotos[id] = true
	}
	survivor := map[int64]bool{}
	var placeIDs []int64
	for _, w := range wps {
		switch {
		case listed[w.ID]:
		case !w.Planned:
			survivor[w.ID] = true
		case w.Status == model.WPVisited || withPhotos[w.ID]:
			survivor[w.ID] = true
			sp.kept = append(sp.kept, w.ID)
		default:
			sp.deleted = append(sp.deleted, w.ID)
			placeIDs = append(placeIDs, service.PlaceIDs(w.PlaceID)...)
		}
	}

	// Lodging, as the single-waypoint endpoints check it, on the plan as a
	// whole: one per night, within the trip's days (see checkLodging).
	days := service.DateSpan(trip.StartDate, trip.EndDate)
	if days == 0 {
		maxDay := 0
		for i := range prep {
			if !prep[i].wp.IsLodging() {
				maxDay = max(maxDay, prep[i].wp.Day)
			}
		}
		for _, w := range wps {
			if survivor[w.ID] && !w.IsLodging() {
				maxDay = max(maxDay, w.Day)
			}
		}
		days = max(trip.PlanDays, maxDay)
	}
	// Fewer days than before: lodging of the nights cut is moved or deleted
	// afterwards, as PATCH /trips/:id does (service.ShrinkDays).
	shrinking := false
	if tu != nil && tu.datesChanged {
		d := service.DateSpan(trip.StartDate, trip.EndDate)
		if d == 0 {
			d = trip.PlanDays
		}
		shrinking = d > 0 && d < tu.oldDays
	}
	nights := map[int]int{} // night → item
	for i := range prep {
		p := &prep[i]
		w := &p.wp
		if !w.IsLodging() {
			continue
		}
		// The range of new lodging and of lodging moved to another night.
		moved := p.cur == nil || p.cur.Kind != w.Kind || p.cur.Day != w.Day
		switch {
		case moved && days > 0 && w.Day > days && !shrinking:
			return nil, itemError(i, errBad(fmt.Sprintf("住宿的 day 超出了旅程天数：共 %d 天，住宿的 day 取值 0–%d（第 N 天晚上住的地方，0 为出发前一晚）", days, days)))
		case moved && days == 0 && w.Day < 1:
			return nil, itemError(i, errBad("请先设置旅程天数，或指定住宿是第几天晚上（day ≥ 1）"))
		}
		if j, dup := nights[w.Day]; dup {
			return nil, itemError(i, errConflict(fmt.Sprintf("%s已有住宿（第 %d 项）", nightName(w.Day), j+1)))
		}
		nights[w.Day] = i
	}
	// Kept lodging (history) on a night the plan gives another hotel stays,
	// as a stop of that day.
	var demote []int64
	for _, w := range wps {
		if _, taken := nights[w.Day]; taken && survivor[w.ID] && w.IsLodging() {
			demote = append(demote, w.ID)
		}
	}

	if len(sp.deleted) > 0 {
		if err := service.DeleteWaypoints(tx, tripID, sp.deleted); err != nil {
			return nil, err
		}
		changed = true
	}
	// One lodging per night is checked row by row (a unique index): lodging
	// changing night steps aside first, as does kept lodging giving way.
	aside := slices.Clone(demote)
	for i := range prep {
		if p := &prep[i]; p.cur != nil && p.cur.IsLodging() && (p.wp.Kind != p.cur.Kind || p.wp.Day != p.cur.Day) {
			aside = append(aside, p.cur.ID)
		}
	}
	if len(aside) > 0 {
		if err := tx.Model(&model.Waypoint{}).Where("trip_id = ? AND id IN ?", tripID, aside).Update("kind", model.KindStop).Error; err != nil {
			return nil, err
		}
		changed = changed || len(demote) > 0
	}
	// Listed waypoints: only the columns the draft changed are written, so
	// that a change made meanwhile to another one (a check-in while a
	// forced save was under way) is not undone.
	for i := range prep {
		p := &prep[i]
		if p.cur == nil {
			continue
		}
		if p.ch.relink {
			pid, err := h.svc.ResolvePlace(tx, &p.wp, !p.wp.AutoNamed, uid)
			if err != nil {
				return nil, err
			}
			p.wp.PlaceID = pid
		}
		cols := changedWaypointColumns(p.orig, &p.wp)
		// Kind and night as drafted (validated above), also over a change
		// made meanwhile, and after stepping aside.
		for _, kd := range []struct {
			col  string
			diff bool
		}{{"kind", p.wp.Kind != p.cur.Kind}, {"day", p.wp.Day != p.cur.Day}} {
			if (kd.diff || slices.Contains(aside, p.cur.ID)) && !slices.Contains(cols, kd.col) {
				cols = append(cols, kd.col)
			}
		}
		if len(cols) > 0 {
			p.wp.ID = p.cur.ID
			if err := tx.Model(&model.Waypoint{ID: p.cur.ID}).Select(cols).Updates(&p.wp).Error; err != nil {
				return nil, itemError(i, err)
			}
			changed = true
		}
		placeIDs = append(placeIDs, service.PlaceIDs(p.orig.PlaceID, p.cur.PlaceID, p.wp.PlaceID)...)
	}
	// New waypoints (placed by the order below).
	seq := len(wps)
	for i := range prep {
		p := &prep[i]
		if p.cur != nil {
			continue
		}
		w := &p.wp
		pid, err := h.svc.ResolvePlace(tx, w, !w.AutoNamed, uid)
		if err != nil {
			return nil, err
		}
		w.PlaceID, w.Seq = pid, seq
		seq++
		if err := tx.Create(w).Error; err != nil {
			return nil, itemError(i, err)
		}
		if err := h.svc.AwardExp(tx, uid, service.ExpKey("waypoint", w.ID), service.ExpWaypoint, "waypoint"); err != nil {
			return nil, err
		}
		placeIDs = append(placeIDs, service.PlaceIDs(w.PlaceID)...)
		changed = true
	}
	for i := range prep {
		if p := &prep[i]; p.key != "" {
			sp.idMap[p.key] = p.wp.ID
		}
	}

	// The order: the list's, each waypoint that is not in it (unplanned or
	// kept) staying right after the listed one it followed.
	after := map[int64][]int64{} // listed waypoint (0: the start) → those following it
	var anchor int64
	var before []int64 // the current order, without the deleted waypoints
	for _, w := range wps {
		switch {
		case listed[w.ID]:
			anchor = w.ID
		case survivor[w.ID]:
			after[anchor] = append(after[anchor], w.ID)
		default:
			continue
		}
		before = append(before, w.ID)
	}
	order := slices.Clone(after[0])
	for i := range prep {
		id := prep[i].wp.ID
		order = append(order, id)
		if prep[i].cur != nil {
			order = append(order, after[id]...)
		}
	}
	if !slices.Equal(order, before) {
		if err := applyOrder(tx, tripID, order); err != nil {
			return nil, err
		}
		changed = true
	}

	if tu != nil {
		if err := h.finishTripUpdate(tx, tu); err != nil {
			return nil, err
		}
	}
	if !changed {
		return sp, nil
	}
	if err := h.svc.RecomputeTrip(tx, tripID); err != nil {
		return nil, err
	}
	if err := h.svc.RecomputePlaces(tx, placeIDs); err != nil {
		return nil, err
	}
	_, err := service.TouchTrip(tx, tripID, uid)
	return sp, err
}
