package handler

import (
	"context"
	"regexp"
	"strings"
	"time"

	"triphub/internal/geo"
	"triphub/internal/media"
	"triphub/internal/model"
	"triphub/internal/service"
)

func (h *Handler) ts(t time.Time) string { return t.In(h.loc).Format(time.RFC3339) }

func (h *Handler) tsp(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := h.ts(*t)
	return &s
}

// UserBrief is the public summary of a user.
type UserBrief struct {
	ID        int64  `json:"id"`
	Username  string `json:"username"`
	Nickname  string `json:"nickname"`
	AvatarURL string `json:"avatar_url"`
	Level     int    `json:"level"`
	Role      string `json:"role"`
}

func userBrief(u *model.User) *UserBrief {
	if u == nil {
		return nil
	}
	l, _ := service.LevelFor(u.Exp)
	nick := u.Nickname
	if nick == "" {
		nick = u.Username
	}
	return &UserBrief{ID: u.ID, Username: u.Username, Nickname: nick, AvatarURL: u.AvatarURL, Level: l.Level, Role: u.Role}
}

func (h *Handler) loadUsers(ctx context.Context, ids []int64) (map[int64]*model.User, error) {
	out := map[int64]*model.User{}
	ids = uniq(ids)
	if len(ids) == 0 {
		return out, nil
	}
	var users []model.User
	if err := h.db.WithContext(ctx).Where("id IN ?", ids).Find(&users).Error; err != nil {
		return nil, err
	}
	for i := range users {
		out[users[i].ID] = &users[i]
	}
	return out, nil
}

func uniq(ids []int64) []int64 {
	seen := map[int64]bool{}
	var out []int64
	for _, id := range ids {
		if id != 0 && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

// MeDTO is the current user's own profile.
type MeDTO struct {
	UserBrief
	Email        string     `json:"email"`
	Bio          string     `json:"bio"`
	Exp          int        `json:"exp"`
	LevelName    string     `json:"level_name"`
	NextLevelExp *int       `json:"next_level_exp"`
	Status       string     `json:"status"`
	StorageUsed  int64      `json:"storage_used"`
	StorageQuota int64      `json:"storage_quota"`
	Partner      *UserBrief `json:"partner"`
	CreatedAt    string     `json:"created_at"`
}

func (h *Handler) meDTO(ctx context.Context, u *model.User) (*MeDTO, error) {
	partnerID, _, err := service.PartnerOf(h.db.WithContext(ctx), u.ID)
	if err != nil {
		return nil, err
	}
	var partner *model.User
	if partnerID != 0 {
		users, err := h.loadUsers(ctx, []int64{partnerID})
		if err != nil {
			return nil, err
		}
		partner = users[partnerID]
	}
	return h.meFrom(u, partner), nil
}

func (h *Handler) meFrom(u, partner *model.User) *MeDTO {
	l, next := service.LevelFor(u.Exp)
	return &MeDTO{
		UserBrief: *userBrief(u), Email: u.Email, Bio: u.Bio, Exp: u.Exp, LevelName: l.Name, NextLevelExp: next,
		Status: u.Status, StorageUsed: u.StorageUsed, StorageQuota: service.QuotaBytes(u), Partner: userBrief(partner),
		CreatedAt: h.ts(u.CreatedAt),
	}
}

// WaypointDTO is the API representation of a waypoint.
type WaypointDTO struct {
	ID        int64   `json:"id"`
	TripID    int64   `json:"trip_id"`
	Seq       int     `json:"seq"`
	Day       int     `json:"day"`
	Planned   bool    `json:"planned"`
	Status    string  `json:"status"`
	PlannedAt *string `json:"planned_at"`
	Name      string  `json:"name"`
	Address   string  `json:"address"`
	Province  string  `json:"province"`
	City      string  `json:"city"`
	District  string  `json:"district"`
	Lng       float64 `json:"lng"`
	Lat       float64 `json:"lat"`
	Category  string  `json:"category"`
	ArrivedAt *string `json:"arrived_at"`
	Note      string  `json:"note"`
	Verdict   string  `json:"verdict"`
	Rating    int     `json:"rating"`
	Cost      float64 `json:"cost"`
	AmapID    string  `json:"amap_id"`
	PlaceID   *int64  `json:"place_id"`
	CreatedAt string  `json:"created_at"`
	UpdatedAt string  `json:"updated_at"`
}

func (h *Handler) waypointDTO(w *model.Waypoint) WaypointDTO {
	return WaypointDTO{
		ID: w.ID, TripID: w.TripID, Seq: w.Seq, Day: w.Day, Planned: w.Planned, Status: w.Status,
		PlannedAt: h.tsp(w.PlannedAt), Name: w.Name, Address: w.Address, Province: w.Province, City: w.City,
		District: w.District, Lng: geo.Round(w.Lng, 6), Lat: geo.Round(w.Lat, 6), Category: w.Category,
		ArrivedAt: h.tsp(w.ArrivedAt), Note: w.Note, Verdict: w.Verdict, Rating: w.Rating, Cost: w.Cost,
		AmapID: w.AmapID, PlaceID: w.PlaceID, CreatedAt: h.ts(w.CreatedAt), UpdatedAt: h.ts(w.UpdatedAt),
	}
}

func (h *Handler) waypointDTOs(ws []model.Waypoint) []WaypointDTO {
	out := make([]WaypointDTO, len(ws))
	for i := range ws {
		out[i] = h.waypointDTO(&ws[i])
	}
	return out
}

// PhotoDTO is the API representation of a photo.
type PhotoDTO struct {
	ID         int64    `json:"id"`
	TripID     int64    `json:"trip_id"`
	WaypointID *int64   `json:"waypoint_id"`
	URL        string   `json:"url"`
	ThumbURL   string   `json:"thumb_url"`
	Width      int      `json:"width"`
	Height     int      `json:"height"`
	TakenAt    *string  `json:"taken_at"`
	Lng        *float64 `json:"lng"`
	Lat        *float64 `json:"lat"`
	Caption    string   `json:"caption"`
	CreatedAt  string   `json:"created_at"`
}

func (h *Handler) photoDTO(p *model.Photo) PhotoDTO {
	return PhotoDTO{
		ID: p.ID, TripID: p.TripID, WaypointID: p.WaypointID, URL: media.URL(p.Path), ThumbURL: media.URL(p.ThumbPath),
		Width: p.Width, Height: p.Height, TakenAt: h.tsp(p.TakenAt), Lng: p.Lng, Lat: p.Lat, Caption: p.Caption,
		CreatedAt: h.ts(p.CreatedAt),
	}
}

func (h *Handler) photoDTOs(ps []model.Photo) []PhotoDTO {
	out := make([]PhotoDTO, len(ps))
	for i := range ps {
		out[i] = h.photoDTO(&ps[i])
	}
	return out
}

// PlaceDTO is the API representation of a place.
type PlaceDTO struct {
	ID             int64   `json:"id"`
	AmapID         string  `json:"amap_id"`
	Name           string  `json:"name"`
	Address        string  `json:"address"`
	Province       string  `json:"province"`
	City           string  `json:"city"`
	District       string  `json:"district"`
	Lng            float64 `json:"lng"`
	Lat            float64 `json:"lat"`
	Category       string  `json:"category"`
	Tel            string  `json:"tel"`
	CheckinCount   int     `json:"checkin_count"`
	RatingAvg      float64 `json:"rating_avg"`
	RatingCount    int     `json:"rating_count"`
	RecommendCount int     `json:"recommend_count"`
	NeutralCount   int     `json:"neutral_count"`
	AvoidCount     int     `json:"avoid_count"`
	AvgCost        float64 `json:"avg_cost"`
	CommentCount   int     `json:"comment_count"`
	CoverURL       string  `json:"cover_url"`
	CreatedAt      string  `json:"created_at"`
	DistanceM      *int    `json:"distance_m,omitempty"`
}

func (h *Handler) placeDTO(p *model.Place) PlaceDTO {
	return PlaceDTO{
		ID: p.ID, AmapID: p.AmapID, Name: p.Name, Address: p.Address, Province: p.Province, City: p.City,
		District: p.District, Lng: geo.Round(p.Lng, 6), Lat: geo.Round(p.Lat, 6), Category: p.Category, Tel: p.Tel,
		CheckinCount: p.CheckinCount, RatingAvg: p.RatingAvg, RatingCount: p.RatingCount,
		RecommendCount: p.RecommendCount, NeutralCount: p.NeutralCount, AvoidCount: p.AvoidCount,
		AvgCost: p.AvgCost, CommentCount: p.CommentCount, CoverURL: p.CoverURL, CreatedAt: h.ts(p.CreatedAt),
	}
}

// TripRef / PlaceRef are minimal references.
type TripRef struct {
	ID    int64  `json:"id"`
	Title string `json:"title"`
}

// PlaceRef is a minimal place reference.
type PlaceRef struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

// TripCard is the list representation of a trip.
type TripCard struct {
	ID            int64        `json:"id"`
	Title         string       `json:"title"`
	Summary       string       `json:"summary"`
	CoverURL      string       `json:"cover_url"`
	Phase         string       `json:"phase"`
	Visibility    string       `json:"visibility"`
	Status        string       `json:"status"`
	StartDate     *string      `json:"start_date"`
	EndDate       *string      `json:"end_date"`
	Days          int          `json:"days"`
	DistanceKm    float64      `json:"distance_km"`
	Cities        []string     `json:"cities"`
	Provinces     []string     `json:"provinces"`
	Tags          []string     `json:"tags"`
	WaypointCount int          `json:"waypoint_count"`
	PlannedCount  int          `json:"planned_count"`
	VisitedCount  int          `json:"visited_count"`
	PhotoCount    int          `json:"photo_count"`
	LikeCount     int          `json:"like_count"`
	CommentCount  int          `json:"comment_count"`
	ForkCount     int          `json:"fork_count"`
	FavCount      int          `json:"fav_count"`
	ViewCount     int          `json:"view_count"`
	Featured      bool         `json:"featured"`
	Together      bool         `json:"together"`
	Author        *UserBrief   `json:"author"`
	Members       []*UserBrief `json:"members"`
	CreatedAt     string       `json:"created_at"`
	UpdatedAt     string       `json:"updated_at"`
	PublishedAt   *string      `json:"published_at"`
}

var (
	mdImage  = regexp.MustCompile(`!\[[^\]]*\]\([^)]*\)`)
	mdLink   = regexp.MustCompile(`\[([^\]]*)\]\([^)]*\)`)
	mdSymbol = regexp.MustCompile("(?m)^\\s{0,3}(#{1,6}|>|[-*+]|\\d+\\.)\\s+|[*_`~]+|<[^>]+>")
	spaces   = regexp.MustCompile(`\s+`)
)

// summarize returns the trip summary, derived from the content when empty.
func summarize(summary, content string) string {
	s := strings.TrimSpace(summary)
	if s == "" && content != "" {
		s = mdImage.ReplaceAllString(content, "")
		s = mdLink.ReplaceAllString(s, "$1")
		s = mdSymbol.ReplaceAllString(s, "")
		s = strings.TrimSpace(spaces.ReplaceAllString(s, " "))
	}
	return service.Truncate(s, 120)
}

func nonNil(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}

func (h *Handler) cardFrom(t *model.Trip, author *model.User, members []*UserBrief, together bool) TripCard {
	cover := t.CoverURL
	if cover == "" {
		cover = t.AutoCoverURL
	}
	if members == nil {
		members = []*UserBrief{}
	}
	return TripCard{
		ID: t.ID, Title: t.Title, Summary: summarize(t.Summary, t.Content), CoverURL: cover,
		Phase: t.Phase, Visibility: t.Visibility, Status: t.Status,
		StartDate: service.FormatDate(t.StartDate), EndDate: service.FormatDate(t.EndDate), Days: t.Days,
		DistanceKm: geo.Round(t.DistanceKm, 1), Cities: nonNil(t.Cities), Provinces: nonNil(t.Provinces), Tags: nonNil(t.Tags),
		WaypointCount: t.WaypointCount, PlannedCount: t.PlannedCount, VisitedCount: t.VisitedCount, PhotoCount: t.PhotoCount,
		LikeCount: t.LikeCount, CommentCount: t.CommentCount, ForkCount: t.ForkCount, FavCount: t.FavCount,
		ViewCount: t.ViewCount, Featured: t.Featured, Together: together, Author: userBrief(author), Members: members,
		CreatedAt: h.ts(t.CreatedAt), UpdatedAt: h.ts(t.UpdatedAt), PublishedAt: h.tsp(t.PublishedAt),
	}
}

// tripCards builds cards for trips with batched lookups of authors, members and partners.
func (h *Handler) tripCards(ctx context.Context, trips []model.Trip) ([]TripCard, error) {
	out := make([]TripCard, 0, len(trips))
	if len(trips) == 0 {
		return out, nil
	}
	db := h.db.WithContext(ctx)
	tripIDs := make([]int64, len(trips))
	ownerIDs := make([]int64, len(trips))
	for i, t := range trips {
		tripIDs[i], ownerIDs[i] = t.ID, t.OwnerID
	}
	var members []model.TripMember
	if err := db.Where("trip_id IN ? AND status = ? AND role = ?", tripIDs, model.MemberAccepted, model.MemberEditor).
		Order("id").Find(&members).Error; err != nil {
		return nil, err
	}
	var parts []model.Partnership
	if err := db.Where("user_a IN ? OR user_b IN ?", uniq(ownerIDs), uniq(ownerIDs)).Find(&parts).Error; err != nil {
		return nil, err
	}
	partnerOf := map[int64]int64{}
	for _, p := range parts {
		partnerOf[p.UserA] = p.UserB
		partnerOf[p.UserB] = p.UserA
	}
	userIDs := append([]int64{}, ownerIDs...)
	byTrip := map[int64][]int64{}
	for _, m := range members {
		userIDs = append(userIDs, m.UserID)
		byTrip[m.TripID] = append(byTrip[m.TripID], m.UserID)
	}
	users, err := h.loadUsers(ctx, userIDs)
	if err != nil {
		return nil, err
	}
	for i := range trips {
		t := &trips[i]
		var mb []*UserBrief
		together := false
		for _, uid := range byTrip[t.ID] {
			if u := users[uid]; u != nil {
				mb = append(mb, userBrief(u))
			}
			if p, ok := partnerOf[t.OwnerID]; ok && p == uid {
				together = true
			}
		}
		out = append(out, h.cardFrom(t, users[t.OwnerID], mb, together))
	}
	return out, nil
}

func (h *Handler) tripCard(ctx context.Context, t *model.Trip) (TripCard, error) {
	cards, err := h.tripCards(ctx, []model.Trip{*t})
	if err != nil {
		return TripCard{}, err
	}
	return cards[0], nil
}

// ForkedFrom references the original trip of a fork.
type ForkedFrom struct {
	ID     int64      `json:"id"`
	Title  string     `json:"title"`
	Author *UserBrief `json:"author"`
}

// TripDetail is the full representation of a trip.
type TripDetail struct {
	TripCard
	Content       string        `json:"content"`
	ShareCode     *string       `json:"share_code"`
	ForkedFrom    *ForkedFrom   `json:"forked_from"`
	Liked         bool          `json:"liked"`
	Favorited     bool          `json:"favorited"`
	CanEdit       bool          `json:"can_edit"`
	IsOwner       bool          `json:"is_owner"`
	InvitePending bool          `json:"invite_pending"`
	Waypoints     []WaypointDTO `json:"waypoints"`
	Photos        []PhotoDTO    `json:"photos"`
	HasTrack      bool          `json:"has_track"`
}

func (h *Handler) tripDetail(ctx context.Context, t *model.Trip, a service.Access, viewer *model.User) (*TripDetail, error) {
	db := h.db.WithContext(ctx)
	card, err := h.tripCard(ctx, t)
	if err != nil {
		return nil, err
	}
	d := &TripDetail{TripCard: card, Content: t.Content, CanEdit: a.CanEdit(), IsOwner: a.Owner,
		InvitePending: a.Pending, HasTrack: t.TrackPointCount > 0}
	d.Summary = t.Summary // the raw summary (cards derive one from content when empty)
	if a.Member {
		code := t.ShareCode
		d.ShareCode = &code
	}
	var wps []model.Waypoint
	if err := db.Where("trip_id = ?", t.ID).Order("seq, id").Find(&wps).Error; err != nil {
		return nil, err
	}
	d.Waypoints = h.waypointDTOs(wps)
	var photos []model.Photo
	if err := db.Where("trip_id = ?", t.ID).Order("taken_at ASC NULLS LAST, id ASC").Find(&photos).Error; err != nil {
		return nil, err
	}
	d.Photos = h.photoDTOs(photos)
	if viewer != nil {
		var n int64
		db.Model(&model.Like{}).Where("user_id = ? AND trip_id = ?", viewer.ID, t.ID).Count(&n)
		d.Liked = n > 0
		db.Model(&model.Favorite{}).Where("user_id = ? AND trip_id = ?", viewer.ID, t.ID).Count(&n)
		d.Favorited = n > 0
	}
	if t.ForkedFromID != nil {
		var orig model.Trip
		if err := db.Limit(1).Find(&orig, *t.ForkedFromID).Error; err != nil {
			return nil, err
		}
		if orig.ID != 0 {
			oa, err := h.svc.TripAccess(db, &orig, viewer, "")
			if err != nil {
				return nil, err
			}
			if oa.CanView(&orig) {
				users, err := h.loadUsers(ctx, []int64{orig.OwnerID})
				if err != nil {
					return nil, err
				}
				d.ForkedFrom = &ForkedFrom{ID: orig.ID, Title: orig.Title, Author: userBrief(users[orig.OwnerID])}
			}
		}
	}
	return d, nil
}

// CommentDTO is the API representation of a comment.
type CommentDTO struct {
	ID         int64        `json:"id"`
	TripID     *int64       `json:"trip_id"`
	PlaceID    *int64       `json:"place_id"`
	WaypointID *int64       `json:"waypoint_id"`
	ParentID   *int64       `json:"parent_id"`
	Content    string       `json:"content"`
	Deleted    bool         `json:"deleted"`
	Author     *UserBrief   `json:"author"`
	ReplyTo    *UserBrief   `json:"reply_to"`
	CanDelete  bool         `json:"can_delete"`
	CreatedAt  string       `json:"created_at"`
	Replies    []CommentDTO `json:"replies"`
	Trip       *TripRef     `json:"trip,omitempty"`
	Place      *PlaceRef    `json:"place,omitempty"`
}

// commentDTOs renders comments; when withReplies is set the non-deleted
// replies of each top-level comment are attached. tripOwner may delete.
func (h *Handler) commentDTOs(ctx context.Context, tops []model.Comment, withReplies bool, viewer *model.User, tripOwner int64) ([]CommentDTO, error) {
	out := make([]CommentDTO, 0, len(tops))
	if len(tops) == 0 {
		return out, nil
	}
	replies := map[int64][]model.Comment{}
	var all []model.Comment
	all = append(all, tops...)
	if withReplies {
		ids := make([]int64, len(tops))
		for i, c := range tops {
			ids[i] = c.ID
		}
		var rs []model.Comment
		if err := h.db.WithContext(ctx).Where("parent_id IN ? AND NOT deleted", ids).Order("created_at, id").Find(&rs).Error; err != nil {
			return nil, err
		}
		for _, r := range rs {
			replies[*r.ParentID] = append(replies[*r.ParentID], r)
		}
		all = append(all, rs...)
	}
	var uids []int64
	for _, c := range all {
		uids = append(uids, c.UserID)
		if c.ReplyToUserID != nil {
			uids = append(uids, *c.ReplyToUserID)
		}
	}
	users, err := h.loadUsers(ctx, uids)
	if err != nil {
		return nil, err
	}
	render := func(c *model.Comment) CommentDTO {
		d := CommentDTO{
			ID: c.ID, TripID: c.TripID, PlaceID: c.PlaceID, WaypointID: c.WaypointID, ParentID: c.ParentID,
			Content: c.Content, Deleted: c.Deleted, Author: userBrief(users[c.UserID]), CreatedAt: h.ts(c.CreatedAt),
			Replies: []CommentDTO{},
		}
		if c.Deleted {
			d.Content = ""
		}
		if c.ReplyToUserID != nil {
			d.ReplyTo = userBrief(users[*c.ReplyToUserID])
		}
		if viewer != nil && !c.Deleted {
			d.CanDelete = viewer.ID == c.UserID || viewer.IsAdmin() || (c.TripID != nil && tripOwner == viewer.ID)
		}
		return d
	}
	for i := range tops {
		d := render(&tops[i])
		for j := range replies[tops[i].ID] {
			d.Replies = append(d.Replies, render(&replies[tops[i].ID][j]))
		}
		out = append(out, d)
	}
	return out, nil
}

// PartnerInviteDTO is the API representation of a partner invite.
type PartnerInviteDTO struct {
	ID        int64      `json:"id"`
	From      *UserBrief `json:"from"`
	To        *UserBrief `json:"to"`
	Message   string     `json:"message"`
	Status    string     `json:"status"`
	CreatedAt string     `json:"created_at"`
}

func (h *Handler) partnerInviteDTOs(ctx context.Context, invs []model.PartnerInvite) ([]PartnerInviteDTO, error) {
	out := make([]PartnerInviteDTO, 0, len(invs))
	var ids []int64
	for _, i := range invs {
		ids = append(ids, i.FromID, i.ToID)
	}
	users, err := h.loadUsers(ctx, ids)
	if err != nil {
		return nil, err
	}
	for _, i := range invs {
		out = append(out, PartnerInviteDTO{ID: i.ID, From: userBrief(users[i.FromID]), To: userBrief(users[i.ToID]),
			Message: i.Message, Status: i.Status, CreatedAt: h.ts(i.CreatedAt)})
	}
	return out, nil
}
