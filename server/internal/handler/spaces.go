package handler

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"triphub/internal/media"
	"triphub/internal/model"
	"triphub/internal/service"
)

// Spaces (空间): a couple, besties, friends, a family or a group of a custom
// kind sharing trips. Every member may open and edit the trips linked to
// the space (see service.TripAccess); members of non-couple spaces may
// invite others, the owner manages the space. See docs/API.md 「空间」.

// Limits of a space's texts (characters).
const (
	maxSpaceName        = 30
	maxSpaceTypeLabel   = 10
	maxSpaceDescription = 120
	maxSpaceInviteMsg   = 200
)

var (
	errSpaceNotFound  = errNotFound("空间不存在或你不是它的成员")
	errInviteNotFound = errNotFound("邀请不存在或已处理")
)

// SpaceRef is a reference to a space.
type SpaceRef struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	TypeLabel string `json:"type_label"` // the display name of the type (情侣 / 闺蜜 / 朋友 / 家人, or the custom one)
}

func spaceRef(sp *model.Space) *SpaceRef {
	if sp == nil || sp.ID == 0 {
		return nil
	}
	return &SpaceRef{ID: sp.ID, Name: sp.Name, Type: sp.Type, TypeLabel: service.SpaceTypeLabel(sp)}
}

// SpaceMemberDTO is a member of a space: a UserBrief with their role in it.
type SpaceMemberDTO struct {
	UserBrief
	SpaceRole string `json:"space_role"` // owner | member
	JoinedAt  string `json:"joined_at"`
}

// TripBrief is a short reference to a trip (the latest trip of a space).
type TripBrief struct {
	ID            int64    `json:"id"`
	Title         string   `json:"title"`
	CoverURL      string   `json:"cover_url"`
	CoverThumbURL string   `json:"cover_thumb_url"`
	Phase         string   `json:"phase"`
	StartDate     *string  `json:"start_date"`
	EndDate       *string  `json:"end_date"`
	Days          int      `json:"days"`
	Cities        []string `json:"cities"`
}

func tripBrief(t *model.Trip) *TripBrief {
	cover := t.CoverURL
	if cover == "" {
		cover = t.AutoCoverURL
	}
	return &TripBrief{ID: t.ID, Title: t.Title, CoverURL: cover, CoverThumbURL: media.ThumbURL(cover), Phase: t.Phase,
		StartDate: service.FormatDate(t.StartDate), EndDate: service.FormatDate(t.EndDate), Days: t.Days, Cities: nonNil(t.Cities)}
}

// SpaceDTO is a space as its members see it (the items of GET /spaces).
type SpaceDTO struct {
	SpaceRef
	Description string           `json:"description"`
	Anniversary *string          `json:"anniversary"`
	Public      bool             `json:"public"`
	Owner       *UserBrief       `json:"owner"`
	Role        string           `json:"role"` // the viewer's role: owner | member
	IsDefault   bool             `json:"is_default"`
	Members     []SpaceMemberDTO `json:"members"`
	MemberCount int              `json:"member_count"`
	TripCount   int              `json:"trip_count"`
	CityCount   int              `json:"city_count"`
	LastTrip    *TripBrief       `json:"last_trip"`
	// PendingInviteCount: invitations to the space awaiting an answer.
	PendingInviteCount int `json:"pending_invite_count"`
	// CanManage: the viewer may change the space's settings (the owner;
	// both members of a couple space). CanInvite: the viewer may invite
	// someone now (allowed to, and the space is not full).
	CanManage bool   `json:"can_manage"`
	CanInvite bool   `json:"can_invite"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

// SpaceStats are the statistics of a space's trips (GET /spaces/:id): the
// stats of its footprints (service.FootStats: trips travelled, visited
// stops, photos, distance, days, cities, provinces, first and last date)
// and the number of trips linked to it, plans included.
type SpaceStats struct {
	service.FootStats
	TripCount int `json:"trip_count"`
}

// SpaceDetail is GET /spaces/:id.
type SpaceDetail struct {
	SpaceDTO
	Stats   SpaceStats       `json:"stats"`
	Invites []SpaceInviteDTO `json:"invites"` // pending invitations to the space
}

// SpaceInviteSpace is the space of an invitation, as the invitee sees it.
type SpaceInviteSpace struct {
	SpaceRef
	Description string       `json:"description"`
	MemberCount int          `json:"member_count"`
	Members     []*UserBrief `json:"members"` // owner first, then by joining
}

// SpaceInviteDTO is an invitation to join a space.
type SpaceInviteDTO struct {
	ID        int64            `json:"id"`
	Space     SpaceInviteSpace `json:"space"`
	Inviter   *UserBrief       `json:"inviter"`
	Invitee   *UserBrief       `json:"invitee"`
	Message   string           `json:"message"`
	Status    string           `json:"status"` // pending | accepted | declined | cancelled
	CreatedAt string           `json:"created_at"`
}

// canManageSpace reports whether a member (role) may change a space's settings.
func canManageSpace(sp *model.Space, role string) bool {
	return role == model.SpaceRoleOwner || (sp.Type == model.SpaceCouple && role != "")
}

// canInviteToSpace reports whether a member (role) may invite someone to a
// space: its owner, or any member of a space that is not a couple space.
func canInviteToSpace(sp *model.Space, role string) bool {
	return role == model.SpaceRoleOwner || (sp.Type != model.SpaceCouple && role != "")
}

// spaceMembers loads the members of spaces, owner first, then by joining.
func (h *Handler) spaceMembers(ctx context.Context, ids []int64) (map[int64][]model.SpaceMember, error) {
	out := map[int64][]model.SpaceMember{}
	if len(ids) == 0 {
		return out, nil
	}
	var rows []model.SpaceMember
	if err := h.db.WithContext(ctx).Where("space_id IN ?", ids).
		Order("space_id, CASE WHEN role = 'owner' THEN 0 ELSE 1 END, joined_at, user_id").Find(&rows).Error; err != nil {
		return nil, err
	}
	for _, m := range rows {
		out[m.SpaceID] = append(out[m.SpaceID], m)
	}
	return out, nil
}

// spaceDTOs builds the DTOs of spaces viewer belongs to.
func (h *Handler) spaceDTOs(ctx context.Context, viewer *model.User, spaces []model.Space) ([]SpaceDTO, error) {
	out := make([]SpaceDTO, 0, len(spaces))
	if len(spaces) == 0 {
		return out, nil
	}
	db := h.db.WithContext(ctx)
	ids := make([]int64, len(spaces))
	for i := range spaces {
		ids[i] = spaces[i].ID
	}
	members, err := h.spaceMembers(ctx, ids)
	if err != nil {
		return nil, err
	}
	var userIDs []int64
	for _, ms := range members {
		for _, m := range ms {
			userIDs = append(userIDs, m.UserID)
		}
	}
	users, err := h.loadUsers(ctx, userIDs)
	if err != nil {
		return nil, err
	}
	counts, err := service.SpaceCountsOf(db, ids)
	if err != nil {
		return nil, err
	}
	var lastIDs []int64
	for _, sc := range counts {
		if sc.LastTripID != 0 {
			lastIDs = append(lastIDs, sc.LastTripID)
		}
	}
	lastTrips := map[int64]*model.Trip{}
	if len(lastIDs) > 0 {
		var ts []model.Trip
		if err := db.Select("id", "title", "cover_url", "auto_cover_url", "phase", "start_date", "end_date", "days", "cities").
			Where("id IN ?", lastIDs).Find(&ts).Error; err != nil {
			return nil, err
		}
		for i := range ts {
			lastTrips[ts[i].ID] = &ts[i]
		}
	}
	for i := range spaces {
		sp := &spaces[i]
		d := SpaceDTO{SpaceRef: *spaceRef(sp), Description: sp.Description, Anniversary: service.FormatDate(sp.Anniversary),
			Public: sp.Public, Owner: userBrief(users[sp.OwnerID]), Members: []SpaceMemberDTO{},
			IsDefault: viewer.DefaultSpaceID != nil && *viewer.DefaultSpaceID == sp.ID,
			CreatedAt: h.ts(sp.CreatedAt), UpdatedAt: h.ts(sp.UpdatedAt)}
		for _, m := range members[sp.ID] {
			if m.UserID == viewer.ID {
				d.Role = m.Role
			}
			if u := users[m.UserID]; u != nil {
				d.Members = append(d.Members, SpaceMemberDTO{UserBrief: *userBrief(u), SpaceRole: m.Role, JoinedAt: h.ts(m.JoinedAt)})
			}
		}
		d.MemberCount = len(members[sp.ID])
		if sc := counts[sp.ID]; sc != nil {
			d.TripCount, d.CityCount, d.PendingInviteCount = sc.Trips, sc.Cities, sc.PendingInvites
			if t := lastTrips[sc.LastTripID]; t != nil {
				d.LastTrip = tripBrief(t)
			}
		}
		d.CanManage = canManageSpace(sp, d.Role)
		d.CanInvite = canInviteToSpace(sp, d.Role) && d.MemberCount+d.PendingInviteCount < service.SpaceCapacity(sp.Type)
		out = append(out, d)
	}
	return out, nil
}

// spaceDetail builds GET /spaces/:id for viewer, a member of sp.
func (h *Handler) spaceDetail(ctx context.Context, viewer *model.User, sp *model.Space) (*SpaceDetail, error) {
	dtos, err := h.spaceDTOs(ctx, viewer, []model.Space{*sp})
	if err != nil {
		return nil, err
	}
	db := h.db.WithContext(ctx)
	d := &SpaceDetail{SpaceDTO: dtos[0], Invites: []SpaceInviteDTO{}}
	st, err := h.svc.FootprintStats(db, service.SpaceTripIDs(db, sp.ID))
	if err != nil {
		return nil, err
	}
	d.Stats = SpaceStats{FootStats: st, TripCount: d.TripCount}
	var invs []model.SpaceInvite
	if err := db.Where("space_id = ? AND status = ?", sp.ID, model.InvitePending).Order("created_at, id").Find(&invs).Error; err != nil {
		return nil, err
	}
	if d.Invites, err = h.spaceInviteDTOs(ctx, invs); err != nil {
		return nil, err
	}
	return d, nil
}

func (h *Handler) respondSpace(c *gin.Context, spaceID int64) error {
	var sp model.Space
	if err := h.db.WithContext(c.Request.Context()).Limit(1).Find(&sp, spaceID).Error; err != nil {
		return err
	}
	if sp.ID == 0 {
		return errSpaceNotFound
	}
	d, err := h.spaceDetail(c.Request.Context(), currentUser(c), &sp)
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, d)
	return nil
}

// spaceInviteDTOs renders invitations.
func (h *Handler) spaceInviteDTOs(ctx context.Context, invs []model.SpaceInvite) ([]SpaceInviteDTO, error) {
	out := make([]SpaceInviteDTO, 0, len(invs))
	if len(invs) == 0 {
		return out, nil
	}
	var spaceIDs, userIDs []int64
	for _, i := range invs {
		spaceIDs = append(spaceIDs, i.SpaceID)
		userIDs = append(userIDs, i.InviterID, i.InviteeID)
	}
	spaceIDs = uniq(spaceIDs)
	var spaces []model.Space
	if err := h.db.WithContext(ctx).Where("id IN ?", spaceIDs).Find(&spaces).Error; err != nil {
		return nil, err
	}
	byID := map[int64]*model.Space{}
	for i := range spaces {
		byID[spaces[i].ID] = &spaces[i]
	}
	members, err := h.spaceMembers(ctx, spaceIDs)
	if err != nil {
		return nil, err
	}
	for _, ms := range members {
		for _, m := range ms {
			userIDs = append(userIDs, m.UserID)
		}
	}
	users, err := h.loadUsers(ctx, userIDs)
	if err != nil {
		return nil, err
	}
	for _, i := range invs {
		sp := byID[i.SpaceID]
		if sp == nil {
			continue
		}
		s := SpaceInviteSpace{SpaceRef: *spaceRef(sp), Description: sp.Description, MemberCount: len(members[sp.ID]), Members: []*UserBrief{}}
		for _, m := range members[sp.ID] {
			if u := users[m.UserID]; u != nil {
				s.Members = append(s.Members, userBrief(u))
			}
		}
		out = append(out, SpaceInviteDTO{ID: i.ID, Space: s, Inviter: userBrief(users[i.InviterID]), Invitee: userBrief(users[i.InviteeID]),
			Message: i.Message, Status: i.Status, CreatedAt: h.ts(i.CreatedAt)})
	}
	return out, nil
}

// spaceForMember loads the :id space when the current user is a member
// (404 otherwise), with the user's membership.
func (h *Handler) spaceForMember(c *gin.Context) (*model.Space, *model.SpaceMember, error) {
	id, err := idParam(c, "id")
	if err != nil {
		return nil, nil, errSpaceNotFound
	}
	db := h.db.WithContext(c.Request.Context())
	var sp model.Space
	if err := db.Limit(1).Find(&sp, id).Error; err != nil {
		return nil, nil, err
	}
	if sp.ID == 0 {
		return nil, nil, errSpaceNotFound
	}
	m, err := service.SpaceMembership(db, sp.ID, currentUserID(c))
	if err != nil {
		return nil, nil, err
	}
	if m == nil {
		return nil, nil, errSpaceNotFound
	}
	return &sp, m, nil
}

// lockSpaceMember locks the space spaceID in tx (service.LockSpace) and
// checks that userID is still a member, returning both.
func lockSpaceMember(tx *gorm.DB, spaceID, userID int64) (*model.Space, *model.SpaceMember, error) {
	sp, err := service.LockSpace(tx, spaceID)
	if err != nil {
		return nil, nil, err
	}
	if sp == nil {
		return nil, nil, errSpaceNotFound
	}
	m, err := service.SpaceMembership(tx, spaceID, userID)
	if err != nil {
		return nil, nil, err
	}
	if m == nil {
		return nil, nil, errSpaceNotFound
	}
	return sp, m, nil
}

func (h *Handler) listSpaces(c *gin.Context) error {
	u := currentUser(c)
	var spaces []model.Space
	if err := h.db.WithContext(c.Request.Context()).Joins("JOIN space_members m ON m.space_id = spaces.id AND m.user_id = ?", u.ID).
		Order("m.joined_at, spaces.id").Find(&spaces).Error; err != nil {
		return err
	}
	dtos, err := h.spaceDTOs(c.Request.Context(), u, spaces)
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, dtos)
	return nil
}

// spaceInput is the body of POST /spaces and PATCH /spaces/:id.
type spaceInput struct {
	Name        *string     `json:"name"`
	Type        *string     `json:"type"`
	TypeLabel   *string     `json:"type_label"`
	Anniversary Opt[string] `json:"anniversary"`
	Description *string     `json:"description"`
	Public      *bool       `json:"public"`
}

// applySpace validates in and writes it into sp (a new space when
// creating), returning the changed columns.
func (h *Handler) applySpace(c *gin.Context, sp *model.Space, in *spaceInput, creating bool) (map[string]any, error) {
	upd := map[string]any{}
	typ := sp.Type
	if in.Type != nil {
		typ = strings.TrimSpace(*in.Type)
	}
	if typ == "" {
		return nil, errBad("请选择空间类型")
	}
	if !service.ValidSpaceType(typ) {
		return nil, errBad("type 只能是 couple / besties / friends / family / custom")
	}
	label := sp.TypeLabel
	if in.TypeLabel != nil {
		v, err := clean(*in.TypeLabel, "类型名称", maxSpaceTypeLabel, false)
		if err != nil {
			return nil, err
		}
		label = v
	}
	if typ != model.SpaceCustom {
		label = "" // the built-in types have their own names
	} else if label == "" {
		return nil, errBad("请填写自定义的空间类型名称（如「驴友团」）")
	}
	var screened []string
	if typ != sp.Type || creating {
		sp.Type, upd["type"] = typ, typ
	}
	if label != sp.TypeLabel || creating {
		sp.TypeLabel, upd["type_label"] = label, label
		screened = append(screened, label)
	}
	if in.Name != nil || creating {
		name := ""
		if in.Name != nil {
			v, err := clean(*in.Name, "空间名称", maxSpaceName, false)
			if err != nil {
				return nil, err
			}
			name = v
		}
		if name == "" {
			if !creating {
				return nil, errBad("空间名称不能为空")
			}
			name = service.DefaultSpaceName(typ, label)
		}
		if name != sp.Name || creating {
			sp.Name, upd["name"] = name, name
			screened = append(screened, name)
		}
	}
	if in.Description != nil {
		v, err := clean(*in.Description, "空间简介", maxSpaceDescription, false)
		if err != nil {
			return nil, err
		}
		if v != sp.Description || creating {
			sp.Description, upd["description"] = v, v
			screened = append(screened, v)
		}
	}
	if in.Anniversary.Set {
		d, err := parseDate(in.Anniversary.V, "anniversary")
		if err != nil {
			return nil, err
		}
		// parseDate gives UTC midnight: compare with today's date in Beijing time.
		if d != nil && d.After(service.DateOnly(time.Now(), h.loc)) {
			return nil, errBad("纪念日不能晚于今天")
		}
		sp.Anniversary, upd["anniversary"] = d, d
	}
	if in.Public != nil {
		if *in.Public && typ != model.SpaceCouple {
			return nil, errBad("只有情侣空间可以在个人主页公开")
		}
		sp.Public, upd["public"] = *in.Public, *in.Public
	}
	if typ != model.SpaceCouple && sp.Public { // no longer a couple space
		sp.Public, upd["public"] = false, false
	}
	if err := h.screen(c, screened...); err != nil {
		return nil, err
	}
	return upd, nil
}

// countSpacesOf counts the spaces a user belongs to.
func countSpacesOf(tx *gorm.DB, userID int64) (int64, error) {
	var n int64
	err := tx.Model(&model.SpaceMember{}).Where("user_id = ?", userID).Count(&n).Error
	return n, err
}

// coupleSpaceOf returns the couple space a user is in (nil: none).
func coupleSpaceOf(tx *gorm.DB, userID int64) (*model.Space, error) {
	var sp model.Space
	if err := tx.Where("id = (SELECT space_id FROM space_members WHERE user_id = ? AND couple LIMIT 1)", userID).
		Limit(1).Find(&sp).Error; err != nil || sp.ID == 0 {
		return nil, err
	}
	return &sp, nil
}

func (h *Handler) createSpace(c *gin.Context) error {
	var in spaceInput
	if err := bindJSON(c, &in); err != nil {
		return err
	}
	u := currentUser(c)
	now := time.Now()
	sp := model.Space{OwnerID: u.ID, CreatedAt: now, UpdatedAt: now}
	if _, err := h.applySpace(c, &sp, &in, true); err != nil {
		return err
	}
	err := h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		if err := service.LockUser(tx, u.ID); err != nil {
			return err
		}
		n, err := countSpacesOf(tx, u.ID)
		if err != nil {
			return err
		}
		if n >= service.MaxSpacesPerUser {
			return errBad(fmt.Sprintf("最多加入 %d 个空间，请先退出一些空间", service.MaxSpacesPerUser))
		}
		if sp.Type == model.SpaceCouple {
			if cur, err := coupleSpaceOf(tx, u.ID); err != nil {
				return err
			} else if cur != nil {
				return errConflict("你已有情侣空间「" + cur.Name + "」，每人只能有一个情侣空间")
			}
		}
		if err := tx.Create(&sp).Error; err != nil {
			return err
		}
		return tx.Create(&model.SpaceMember{SpaceID: sp.ID, UserID: u.ID, Role: model.SpaceRoleOwner, JoinedAt: now,
			Couple: sp.Type == model.SpaceCouple}).Error
	})
	if err != nil {
		return err
	}
	return h.respondSpace(c, sp.ID)
}

func (h *Handler) getSpace(c *gin.Context) error {
	sp, _, err := h.spaceForMember(c)
	if err != nil {
		return err
	}
	d, err := h.spaceDetail(c.Request.Context(), currentUser(c), sp)
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, d)
	return nil
}

func (h *Handler) updateSpace(c *gin.Context) error {
	sp, m, err := h.spaceForMember(c)
	if err != nil {
		return err
	}
	if !canManageSpace(sp, m.Role) {
		return errForbidden("只有空间的创建者可以修改空间设置")
	}
	var in spaceInput
	if err := bindJSON(c, &in); err != nil {
		return err
	}
	// Validated now (sensitive words, dates), applied under the lock to the space as it is then.
	if _, err := h.applySpace(c, &model.Space{Type: sp.Type, TypeLabel: sp.TypeLabel, Name: sp.Name,
		Description: sp.Description, Public: sp.Public}, &in, false); err != nil {
		return err
	}
	me := currentUserID(c)
	err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		cur, m, err := lockSpaceMember(tx, sp.ID, me)
		if err != nil {
			return err
		}
		if !canManageSpace(cur, m.Role) {
			return errForbidden("只有空间的创建者可以修改空间设置")
		}
		wasCouple := cur.Type == model.SpaceCouple
		upd, err := h.applySpace(c, cur, &in, false)
		if err != nil {
			return err
		}
		if len(upd) == 0 {
			return nil
		}
		if couple := cur.Type == model.SpaceCouple; couple != wasCouple {
			if couple {
				if err := checkCoupleCapacity(tx, cur.ID); err != nil {
					return err
				}
			}
			// The flag of the one-couple-space-per-user index (a unique violation: 409).
			if err := tx.Model(&model.SpaceMember{}).Where("space_id = ?", cur.ID).Update("couple", couple).Error; err != nil {
				if errors.Is(err, gorm.ErrDuplicatedKey) {
					return errConflict("有成员已在另一个情侣空间中，不能改为情侣空间")
				}
				return err
			}
		}
		upd["updated_at"] = time.Now()
		if err := tx.Model(&model.Space{}).Where("id = ?", cur.ID).Updates(upd).Error; err != nil {
			return err
		}
		_, retyped := upd["type"]
		_, relabeled := upd["type_label"]
		if !retyped && !relabeled {
			return nil
		}
		// The other members, and those invited (their invitation now shows
		// the new type), hear of the new type.
		var told []int64
		if err := tx.Raw(`SELECT user_id FROM space_members WHERE space_id = ? AND user_id <> ?
UNION SELECT invitee_id FROM space_invites WHERE space_id = ? AND status = ?`, cur.ID, me, cur.ID, model.InvitePending).
			Scan(&told).Error; err != nil {
			return err
		}
		content := userBrief(currentUser(c)).Nickname + " 把空间「" + cur.Name + "」改成了「" + service.SpaceTypeLabel(cur) + "」空间"
		for _, uid := range told {
			if err := h.svc.Notify(tx, service.Notice{UserID: uid, Type: "system", ActorID: me, SpaceID: cur.ID, Content: content}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	return h.respondSpace(c, sp.ID)
}

// checkCoupleCapacity refuses to make a space a couple space unless the one
// asking is its only member (a couple needs the other one's consent: an
// invitation they accept, which shows the space's type) with at most one
// invitation pending, or when the member is in another couple space.
func checkCoupleCapacity(tx *gorm.DB, spaceID int64) error {
	var members, pending int64
	if err := tx.Model(&model.SpaceMember{}).Where("space_id = ?", spaceID).Count(&members).Error; err != nil {
		return err
	}
	if err := tx.Model(&model.SpaceInvite{}).Where("space_id = ? AND status = ?", spaceID, model.InvitePending).Count(&pending).Error; err != nil {
		return err
	}
	if members > 1 {
		return errConflict("空间里已有其他成员，不能改成情侣空间：情侣关系需要对方同意，请新建一个情侣空间邀请 TA")
	}
	if members+pending > 2 {
		return errBad("情侣空间最多两个人（含待接受的邀请），请先撤回多余的邀请")
	}
	var names []string
	if err := tx.Raw(`SELECT u.nickname FROM space_members m JOIN users u ON u.id = m.user_id
WHERE m.couple AND m.space_id <> ? AND m.user_id IN (SELECT user_id FROM space_members WHERE space_id = ?) LIMIT 1`,
		spaceID, spaceID).Scan(&names).Error; err != nil {
		return err
	}
	if len(names) > 0 {
		return errConflict("「" + names[0] + "」已在另一个情侣空间中，不能改为情侣空间")
	}
	return nil
}

func (h *Handler) deleteSpace(c *gin.Context) error {
	sp, m, err := h.spaceForMember(c)
	if err != nil {
		return err
	}
	if m.Role != model.SpaceRoleOwner {
		return errForbidden("只有空间的创建者可以删除空间")
	}
	me := currentUser(c)
	removeShared := queryBool(c, "remove_shared_access")
	err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		cur, m, err := lockSpaceMember(tx, sp.ID, me.ID)
		if err != nil {
			return err
		}
		if m.Role != model.SpaceRoleOwner {
			return errForbidden("只有空间的创建者可以删除空间")
		}
		var partner int64
		var linked []int64
		if removeShared && cur.Type == model.SpaceCouple {
			if err := tx.Model(&model.Trip{}).Where("space_id = ?", cur.ID).Pluck("id", &linked).Error; err != nil {
				return err
			}
			if partner, err = lockCoupleTrips(tx, cur.ID, me.ID, linked); err != nil {
				return err
			}
		}
		members, err := service.DeleteSpace(tx, cur.ID, me.ID)
		if err != nil {
			return err
		}
		ended := 0
		if partner != 0 {
			if ended, err = service.EndCoAuthorship(tx, me.ID, partner, me.ID, linked); err != nil {
				return err
			}
		}
		content := userBrief(me).Nickname + " 删除了空间「" + cur.Name + "」（空间里的旅程仍归各自的作者）"
		if ended > 0 {
			content = userBrief(me).Nickname + " 删除了空间「" + cur.Name + "」，并结束了你们在彼此旅程中的共同作者关系（旅程仍归各自的作者）"
		}
		for _, uid := range members {
			if err := h.svc.Notify(tx, service.Notice{UserID: uid, Type: "system", ActorID: me.ID, SpaceID: cur.ID,
				Content: content}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{})
	return nil
}

// findInvitee resolves the user to invite: user_id, else username (a
// leading @ is ignored).
func (h *Handler) findInvitee(c *gin.Context, userID int64, username string) (*model.User, error) {
	db := h.db.WithContext(c.Request.Context())
	var target model.User
	switch name := strings.TrimPrefix(strings.TrimSpace(username), "@"); {
	case userID > 0:
		if err := db.Limit(1).Find(&target, userID).Error; err != nil {
			return nil, err
		}
	case name != "":
		if err := db.Where("lower(username) = lower(?)", name).Limit(1).Find(&target).Error; err != nil {
			return nil, err
		}
	default:
		return nil, errBad("请输入对方的用户名")
	}
	if target.ID == 0 || target.Status == model.UserDeleted {
		return nil, errNotFound("用户不存在")
	}
	if target.ID == currentUserID(c) {
		return nil, errBad("不能邀请自己")
	}
	if target.Status == model.UserBanned {
		return nil, errBad("该用户无法被邀请")
	}
	return &target, nil
}

// inviteToSpace invites target to space spaceID for the current user (a
// member allowed to invite), in tx, and notifies them.
func (h *Handler) inviteToSpace(c *gin.Context, tx *gorm.DB, spaceID int64, target *model.User, msg string) (*model.SpaceInvite, error) {
	me := currentUser(c)
	sp, m, err := lockSpaceMember(tx, spaceID, me.ID)
	if err != nil {
		return nil, err
	}
	if !canInviteToSpace(sp, m.Role) {
		return nil, errForbidden("只有空间的创建者可以邀请")
	}
	if tm, err := service.SpaceMembership(tx, sp.ID, target.ID); err != nil {
		return nil, err
	} else if tm != nil {
		return nil, errConflict("对方已在空间中")
	}
	var pending int64
	if err := tx.Model(&model.SpaceInvite{}).Where("space_id = ? AND invitee_id = ? AND status = ?", sp.ID, target.ID, model.InvitePending).
		Count(&pending).Error; err != nil {
		return nil, err
	}
	if pending > 0 {
		return nil, errConflict("已邀请过对方，请等待对方回应")
	}
	var members int64
	if err := tx.Model(&model.SpaceMember{}).Where("space_id = ?", sp.ID).Count(&members).Error; err != nil {
		return nil, err
	}
	if err := tx.Model(&model.SpaceInvite{}).Where("space_id = ? AND status = ?", sp.ID, model.InvitePending).Count(&pending).Error; err != nil {
		return nil, err
	}
	if members+pending >= int64(service.SpaceCapacity(sp.Type)) {
		if sp.Type == model.SpaceCouple {
			if members >= 2 {
				return nil, errConflict("情侣空间只能有两个人")
			}
			return nil, errConflict("已邀请了另一个人，请先撤回那条邀请")
		}
		return nil, errBad(fmt.Sprintf("空间最多 %d 人（含待接受的邀请）", service.MaxSpaceMembers))
	}
	if sp.Type == model.SpaceCouple {
		partner, tsp, err := service.PartnerOf(tx, target.ID)
		if err != nil {
			return nil, err
		}
		if partner != 0 {
			return nil, errConflict("对方已有情侣")
		}
		if tsp != nil {
			var n int64
			if err := tx.Model(&model.SpaceInvite{}).Where("space_id = ? AND invitee_id = ? AND status = ?", tsp.ID, me.ID, model.InvitePending).
				Count(&n).Error; err != nil {
				return nil, err
			}
			if n > 0 {
				return nil, errConflict("对方已邀请你加入情侣空间，请直接接受")
			}
		}
	}
	if n, err := countSpacesOf(tx, target.ID); err != nil {
		return nil, err
	} else if n >= service.MaxSpacesPerUser {
		return nil, errConflict("对方加入的空间已达上限")
	}
	inv := &model.SpaceInvite{SpaceID: sp.ID, InviterID: me.ID, InviteeID: target.ID, Message: msg, Status: model.InvitePending}
	if err := tx.Create(inv).Error; err != nil {
		if errors.Is(err, gorm.ErrDuplicatedKey) {
			return nil, errConflict("已邀请过对方，请等待对方回应")
		}
		return nil, err
	}
	// content is the inviter's own words only: clients show it as a quote.
	if err := h.svc.Notify(tx, service.Notice{UserID: target.ID, Type: "space_invite", ActorID: me.ID, SpaceID: sp.ID, Content: msg}); err != nil {
		return nil, err
	}
	return inv, nil
}

// inviteMessage validates an invitation's message.
func (h *Handler) inviteMessage(c *gin.Context, s string) (string, error) {
	msg, err := clean(s, "留言", maxSpaceInviteMsg, false)
	if err != nil {
		return "", err
	}
	if err := h.screen(c, msg); err != nil {
		return "", err
	}
	if !h.inviteLimit.Allow(strconv.FormatInt(currentUserID(c), 10)) {
		return "", errTooMany("邀请过于频繁，请稍后再试")
	}
	return msg, nil
}

func (h *Handler) createSpaceInvite(c *gin.Context) error {
	sp, m, err := h.spaceForMember(c)
	if err != nil {
		return err
	}
	if !canInviteToSpace(sp, m.Role) {
		return errForbidden("只有空间的创建者可以邀请")
	}
	var req struct {
		Username string `json:"username"`
		UserID   int64  `json:"user_id"`
		Message  string `json:"message"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	target, err := h.findInvitee(c, req.UserID, req.Username)
	if err != nil {
		return err
	}
	msg, err := h.inviteMessage(c, req.Message)
	if err != nil {
		return err
	}
	var inv *model.SpaceInvite
	err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		var err error
		inv, err = h.inviteToSpace(c, tx, sp.ID, target, msg)
		return err
	})
	if err != nil {
		return err
	}
	dtos, err := h.spaceInviteDTOs(c.Request.Context(), []model.SpaceInvite{*inv})
	if err != nil {
		return err
	}
	if len(dtos) == 0 { // the space was deleted right after (and the invitation with it)
		return errSpaceNotFound
	}
	c.JSON(http.StatusOK, dtos[0])
	return nil
}

func (h *Handler) listSpaceInvites(c *gin.Context) error {
	u := currentUser(c)
	db := h.db.WithContext(c.Request.Context())
	var incoming, outgoing []model.SpaceInvite
	if err := db.Where("invitee_id = ? AND status = ?", u.ID, model.InvitePending).Order("created_at DESC, id DESC").Find(&incoming).Error; err != nil {
		return err
	}
	if err := db.Where("inviter_id = ? AND status = ?", u.ID, model.InvitePending).Order("created_at DESC, id DESC").Find(&outgoing).Error; err != nil {
		return err
	}
	in, err := h.spaceInviteDTOs(c.Request.Context(), incoming)
	if err != nil {
		return err
	}
	out, err := h.spaceInviteDTOs(c.Request.Context(), outgoing)
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{"incoming": in, "outgoing": out})
	return nil
}

// joinSpace accepts the current user's pending invitation inviteID (to a
// couple space only when coupleOnly) and returns the space joined. Joining
// a couple space withdraws the user's and the inviter's other pending couple
// invitations, and the space's (it is full). A couple space the user is
// alone in (one waiting for a partner, such as the one their invitation link
// was sent from) is not lost: when it has trips and the inviter's has none,
// the inviter moves into it instead (see moveIntoOwnCouple); otherwise it is
// dropped, its name, anniversary and description filling those the joined
// space lacks. Everyone is in at most one couple space.
func (h *Handler) joinSpace(c *gin.Context, inviteID int64, coupleOnly bool) (*model.Space, error) {
	me := currentUser(c)
	db := h.db.WithContext(c.Request.Context())
	var inv model.SpaceInvite
	if err := db.Where("id = ? AND invitee_id = ? AND status = ?", inviteID, me.ID, model.InvitePending).Limit(1).Find(&inv).Error; err != nil {
		return nil, err
	}
	if inv.ID == 0 {
		return nil, errInviteNotFound
	}
	// ownSpaceBlocks refuses to join a couple space while the user shares
	// another one, or when both that one and the space invited to have trips
	// (which of them to keep is theirs to decide). keepOwn: the user's space
	// has trips and the other none, so the inviter moves into the user's.
	ownSpaceBlocks := func(tx *gorm.DB, own *model.Space, targetID int64) (keepOwn bool, err error) {
		var others, trips int64
		if err := tx.Model(&model.SpaceMember{}).Where("space_id = ? AND user_id <> ?", own.ID, me.ID).Count(&others).Error; err != nil {
			return false, err
		}
		if others > 0 {
			return false, errConflict("你已在情侣空间「" + own.Name + "」中，请先退出或删除它，再接受邀请")
		}
		if err := tx.Model(&model.Trip{}).Where("space_id = ?", own.ID).Count(&trips).Error; err != nil || trips == 0 {
			return false, err
		}
		var theirs int64
		if err := tx.Model(&model.Trip{}).Where("space_id = ?", targetID).Count(&theirs).Error; err != nil {
			return false, err
		}
		if theirs > 0 {
			return false, errConflict("你的情侣空间「" + own.Name + "」和对方的都已有旅程，只能保留一个：请先把「" + own.Name + "」里的旅程移出空间或删除这个空间，再接受邀请")
		}
		return true, nil
	}
	var joined *model.Space
	err := db.Transaction(func(tx *gorm.DB) error {
		// Lock order: the user (their spaces), then the spaces in id order.
		if err := service.LockUser(tx, me.ID); err != nil {
			return err
		}
		var target model.Space
		if err := tx.Select("id", "type").Limit(1).Find(&target, inv.SpaceID).Error; err != nil {
			return err
		}
		if target.ID == 0 || (coupleOnly && target.Type != model.SpaceCouple) {
			return errInviteNotFound
		}
		var own *model.Space // the user's couple space, dropped or kept when they join another
		if target.Type == model.SpaceCouple {
			cur, err := coupleSpaceOf(tx, me.ID)
			if err != nil {
				return err
			}
			if cur != nil && cur.ID != target.ID {
				// Checked before locking it: a space shared with someone else is
				// never locked here (its other member may be deleting it).
				if _, err := ownSpaceBlocks(tx, cur, target.ID); err != nil {
					return err
				}
				own = cur
			}
		}
		lockOwn := func() error {
			var err error
			own, err = service.LockSpace(tx, own.ID) // nil: deleted meanwhile
			return err
		}
		if own != nil && own.ID < target.ID {
			if err := lockOwn(); err != nil {
				return err
			}
		}
		sp, err := service.LockSpace(tx, target.ID)
		if err != nil {
			return err
		}
		if own != nil && own.ID > target.ID {
			if err := lockOwn(); err != nil {
				return err
			}
		}
		if sp == nil || (coupleOnly && sp.Type != model.SpaceCouple) {
			return errInviteNotFound
		}
		// Only a still-pending invitation: it may have been withdrawn or
		// declined meanwhile (the rollback undoes this on any error below).
		res := tx.Model(&model.SpaceInvite{}).Where("id = ? AND status = ?", inv.ID, model.InvitePending).
			Updates(map[string]any{"status": model.InviteAccepted, "updated_at": time.Now()})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return errInviteNotFound
		}
		if m, err := service.SpaceMembership(tx, sp.ID, me.ID); err != nil {
			return err
		} else if m != nil {
			joined = sp
			return nil
		}
		var members int64
		if err := tx.Model(&model.SpaceMember{}).Where("space_id = ?", sp.ID).Count(&members).Error; err != nil {
			return err
		}
		if members >= int64(service.SpaceCapacity(sp.Type)) {
			if sp.Type == model.SpaceCouple {
				return errConflict("对方已有情侣")
			}
			return errConflict("空间人数已满")
		}
		n, err := countSpacesOf(tx, me.ID)
		if err != nil {
			return err
		}
		couple := sp.Type == model.SpaceCouple
		if couple && own != nil {
			keepOwn, err := ownSpaceBlocks(tx, own, sp.ID) // again, under the lock
			if err != nil {
				return err
			}
			if keepOwn {
				if err := h.moveIntoOwnCouple(tx, own, sp, inv.InviterID, me); err != nil {
					return err
				}
				joined = own
				return nil
			}
			if err := fillCoupleSpace(tx, sp, own, me.ID); err != nil {
				return err
			}
			if _, err := service.DeleteSpace(tx, own.ID, me.ID); err != nil {
				return err
			}
			n--
		}
		if n >= service.MaxSpacesPerUser {
			return errConflict(fmt.Sprintf("你加入的空间已达上限（%d 个），请先退出一些空间", service.MaxSpacesPerUser))
		}
		if err := tx.Create(&model.SpaceMember{SpaceID: sp.ID, UserID: me.ID, Role: model.SpaceRoleMember, JoinedAt: time.Now(),
			Couple: couple}).Error; err != nil {
			if errors.Is(err, gorm.ErrDuplicatedKey) {
				return errConflict("你已在另一个情侣空间中")
			}
			return err
		}
		if couple {
			if err := cancelCoupleInvites(tx, sp.ID, me.ID, inv.InviterID); err != nil {
				return err
			}
		}
		if err := h.svc.Notify(tx, service.Notice{UserID: inv.InviterID, Type: "space_accept", ActorID: me.ID, SpaceID: sp.ID,
			Content: "接受了邀请，加入了「" + sp.Name + "」"}); err != nil {
			return err
		}
		if sp.OwnerID != inv.InviterID {
			if err := h.svc.Notify(tx, service.Notice{UserID: sp.OwnerID, Type: "space_accept", ActorID: me.ID, SpaceID: sp.ID,
				Content: "加入了「" + sp.Name + "」"}); err != nil {
				return err
			}
		}
		joined = sp
		return nil
	})
	if err != nil {
		return nil, err
	}
	return joined, nil
}

// cancelCoupleInvites withdraws, once two people form a couple in space
// spaceID (now full), its pending invitations and those inviting either of
// them to another couple space.
func cancelCoupleInvites(tx *gorm.DB, spaceID, a, b int64) error {
	return tx.Exec(`UPDATE space_invites SET status = ?, updated_at = now() WHERE status = ? AND (space_id = ?
  OR (invitee_id IN (?, ?) AND space_id IN (SELECT id FROM spaces WHERE type = ?)))`,
		model.InviteCancelled, model.InvitePending, spaceID, a, b, model.SpaceCouple).Error
}

// coupleDetails are the fields of a couple space that one of its partners
// prepared while waiting for the other.
func coupleDetails(sp *model.Space) map[string]any {
	out := map[string]any{}
	if sp.Name != service.DefaultSpaceName(model.SpaceCouple, "") {
		out["name"] = sp.Name
	}
	if sp.Anniversary != nil {
		out["anniversary"] = sp.Anniversary
	}
	if sp.Description != "" {
		out["description"] = sp.Description
	}
	return out
}

// fillCoupleSpace gives couple space sp (locked) the details of the user's
// own couple space from (locked, about to be dropped) that sp lacks — its
// name when sp has the default one, its anniversary, its description — and
// makes sp the user's default space when from was.
func fillCoupleSpace(tx *gorm.DB, sp, from *model.Space, userID int64) error {
	have := coupleDetails(sp)
	upd := map[string]any{}
	for k, v := range coupleDetails(from) {
		if _, ok := have[k]; !ok {
			upd[k] = v
		}
	}
	if len(upd) > 0 {
		upd["updated_at"] = time.Now()
		if err := tx.Model(&model.Space{}).Where("id = ?", sp.ID).Updates(upd).Error; err != nil {
			return err
		}
		if v, ok := upd["name"].(string); ok {
			sp.Name = v
		}
	}
	return tx.Exec("UPDATE users SET default_space_id = ? WHERE id = ? AND default_space_id = ?", sp.ID, userID, from.ID).Error
}

// moveIntoOwnCouple accepts an invitation to couple space target (locked,
// without trips) by bringing its inviter into the user's own couple space
// own (locked; the user its only member, with trips): target is dropped,
// its details filling those own lacks, and own is public only when both
// were (the inviter never agreed to more).
func (h *Handler) moveIntoOwnCouple(tx *gorm.DB, own, target *model.Space, inviterID int64, me *model.User) error {
	if err := fillCoupleSpace(tx, own, target, inviterID); err != nil {
		return err
	}
	if own.Public && !target.Public {
		if err := tx.Model(&model.Space{}).Where("id = ?", own.ID).Update("public", false).Error; err != nil {
			return err
		}
	}
	if _, err := service.DeleteSpace(tx, target.ID, me.ID); err != nil {
		return err
	}
	if err := tx.Create(&model.SpaceMember{SpaceID: own.ID, UserID: inviterID, Role: model.SpaceRoleMember, JoinedAt: time.Now(),
		Couple: true}).Error; err != nil {
		if errors.Is(err, gorm.ErrDuplicatedKey) {
			return errConflict("对方已在另一个情侣空间中")
		}
		return err
	}
	if err := cancelCoupleInvites(tx, own.ID, me.ID, inviterID); err != nil {
		return err
	}
	return h.svc.Notify(tx, service.Notice{UserID: inviterID, Type: "space_accept", ActorID: me.ID, SpaceID: own.ID,
		Content: "接受了邀请：TA 之前建好了情侣空间「" + own.Name + "」，你们现在都在这里"})
}

func (h *Handler) acceptSpaceInvite(c *gin.Context) error {
	id, err := idParam(c, "id")
	if err != nil {
		return errInviteNotFound
	}
	sp, err := h.joinSpace(c, id, false)
	if err != nil {
		return err
	}
	return h.respondSpace(c, sp.ID)
}

// answerSpaceInvite declines (the invitee) or withdraws (the inviter or the
// space's owner) the pending invitation inviteID, only one of a couple
// space when coupleOnly.
func (h *Handler) answerSpaceInvite(c *gin.Context, inviteID int64, decline, coupleOnly bool) error {
	me := currentUser(c)
	db := h.db.WithContext(c.Request.Context())
	var inv model.SpaceInvite
	if err := db.Where("id = ? AND status = ?", inviteID, model.InvitePending).Limit(1).Find(&inv).Error; err != nil {
		return err
	}
	var sp model.Space
	if inv.ID != 0 {
		if err := db.Limit(1).Find(&sp, inv.SpaceID).Error; err != nil {
			return err
		}
	}
	allowed := inv.InviteeID == me.ID
	if !decline {
		allowed = inv.InviterID == me.ID || (sp.ID != 0 && sp.OwnerID == me.ID)
	}
	if inv.ID == 0 || sp.ID == 0 || !allowed || (coupleOnly && sp.Type != model.SpaceCouple) {
		return errInviteNotFound
	}
	status := model.InviteCancelled
	if decline {
		status = model.InviteDeclined
	}
	return db.Transaction(func(tx *gorm.DB) error {
		// Conditional, so it cannot overwrite an invitation accepted meanwhile.
		res := tx.Model(&model.SpaceInvite{}).Where("id = ? AND status = ?", inv.ID, model.InvitePending).
			Updates(map[string]any{"status": status, "updated_at": time.Now()})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return errInviteNotFound
		}
		if !decline {
			return nil
		}
		return h.svc.Notify(tx, service.Notice{UserID: inv.InviterID, Type: "space_decline", ActorID: me.ID, SpaceID: sp.ID,
			Content: "拒绝了加入「" + sp.Name + "」的邀请"})
	})
}

func (h *Handler) declineSpaceInvite(c *gin.Context) error {
	id, err := idParam(c, "id")
	if err != nil {
		return errInviteNotFound
	}
	if err := h.answerSpaceInvite(c, id, true, false); err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{})
	return nil
}

func (h *Handler) cancelSpaceInvite(c *gin.Context) error {
	id, err := idParam(c, "id")
	if err != nil {
		return errInviteNotFound
	}
	if err := h.answerSpaceInvite(c, id, false, false); err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{})
	return nil
}

// lockCoupleTrips prepares ending the co-authorship of the two members of
// couple space spaceID (?remove_shared_access=true on leaving, removing or
// deleting it; see service.EndCoAuthorship): it returns the member other
// than userID (0: none) after locking, in id order, the trips that change —
// those one of them owns and the other co-authors, and leaving (the trips
// about to leave the space).
func lockCoupleTrips(tx *gorm.DB, spaceID, userID int64, leaving []int64) (int64, error) {
	var others []int64
	if err := tx.Model(&model.SpaceMember{}).Where("space_id = ? AND user_id <> ?", spaceID, userID).Pluck("user_id", &others).Error; err != nil {
		return 0, err
	}
	if len(others) != 1 {
		return 0, nil
	}
	shared, err := service.CoAuthoredTrips(tx, userID, others[0])
	if err != nil {
		return 0, err
	}
	return others[0], service.LockTrips(tx, append(shared, leaving...))
}

// leaveSpace takes userID out of space spaceID for the current user (the
// owner, or userID themself) in tx, with the notices it calls for; see
// service.RemoveSpaceMember. removeShared (couple spaces): the two also stop
// being co-authors of each other's trips (service.EndCoAuthorship).
func (h *Handler) leaveSpace(c *gin.Context, tx *gorm.DB, spaceID, userID int64, removeShared bool) (*service.SpaceLeft, error) {
	me := currentUser(c)
	sp, m, err := lockSpaceMember(tx, spaceID, me.ID)
	if err != nil {
		return nil, err
	}
	self := userID == me.ID
	if !self && m.Role != model.SpaceRoleOwner {
		return nil, errForbidden("只有空间的创建者可以移除成员")
	}
	if tm, err := service.SpaceMembership(tx, sp.ID, userID); err != nil {
		return nil, err
	} else if tm == nil {
		return nil, errNotFound("成员不存在")
	}
	var partner int64
	if removeShared && sp.Type == model.SpaceCouple {
		var leaving []int64 // the trips leaving the space with the member
		if err := tx.Model(&model.Trip{}).Where("space_id = ? AND owner_id = ?", sp.ID, userID).Pluck("id", &leaving).Error; err != nil {
			return nil, err
		}
		if partner, err = lockCoupleTrips(tx, sp.ID, userID, leaving); err != nil {
			return nil, err
		}
	}
	owner := sp.OwnerID
	left, err := service.RemoveSpaceMember(tx, sp, userID, me.ID)
	if err != nil {
		return nil, err
	}
	ended := ""
	if partner != 0 {
		n, err := service.EndCoAuthorship(tx, userID, partner, me.ID, left.Unlinked)
		if err != nil {
			return nil, err
		}
		if n > 0 {
			ended = "，并结束了你们在彼此旅程中的共同作者关系"
		}
	}
	nick := userBrief(me).Nickname
	notice := func(uid int64, content string) error {
		return h.svc.Notify(tx, service.Notice{UserID: uid, Type: "system", ActorID: me.ID, SpaceID: sp.ID, Content: content})
	}
	switch {
	case !self:
		if err := notice(userID, nick+" 将你移出了空间「"+sp.Name+"」"+ended); err != nil {
			return nil, err
		}
	case left.Deleted:
	case left.NewOwnerID != 0:
		if err := notice(left.NewOwnerID, nick+" 退出了空间「"+sp.Name+"」"+ended+"，你成为了空间的创建者"); err != nil {
			return nil, err
		}
	default:
		if err := notice(owner, nick+" 退出了空间「"+sp.Name+"」"+ended); err != nil {
			return nil, err
		}
	}
	return left, nil
}

func (h *Handler) removeSpaceMember(c *gin.Context) error {
	sp, _, err := h.spaceForMember(c)
	if err != nil {
		return err
	}
	uid, err := strconv.ParseInt(c.Param("user_id"), 10, 64)
	if err != nil || uid <= 0 {
		return errNotFound("成员不存在")
	}
	removeShared := queryBool(c, "remove_shared_access")
	err = h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		_, err := h.leaveSpace(c, tx, sp.ID, uid, removeShared)
		return err
	})
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{})
	return nil
}

func (h *Handler) spaceTrips(c *gin.Context) error {
	sp, _, err := h.spaceForMember(c)
	if err != nil {
		return err
	}
	q := h.db.WithContext(c.Request.Context()).Model(&model.Trip{}).Where("space_id = ?", sp.ID)
	if p := c.Query("phase"); p != "" {
		if !validPhase(p) {
			return errBad("phase 参数无效")
		}
		q = q.Where("phase = ?", p)
	}
	return h.respondTripPage(c, q, service.SpaceTripOrder())
}

func (h *Handler) spaceFootprints(c *gin.Context) error {
	sp, _, err := h.spaceForMember(c)
	if err != nil {
		return err
	}
	db := h.db.WithContext(c.Request.Context())
	fp, err := h.svc.BuildFootprints(db, service.SpaceTripIDs(db, sp.ID))
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, fp)
	return nil
}

// setDefaultSpace is PUT /me/default-space {space_id}: the space 「我们」
// opens (null or 0: none, the overview).
func (h *Handler) setDefaultSpace(c *gin.Context) error {
	var req struct {
		SpaceID *int64 `json:"space_id"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	u := currentUser(c)
	var value any = gorm.Expr("NULL")
	var id *int64
	if req.SpaceID != nil && *req.SpaceID != 0 {
		value, id = *req.SpaceID, req.SpaceID
	}
	err := h.db.WithContext(c.Request.Context()).Transaction(func(tx *gorm.DB) error {
		if id != nil {
			// The membership stays until this commits (leaving deletes it first, then clears the default).
			var m []model.SpaceMember
			if err := tx.Clauses(clause.Locking{Strength: "SHARE"}).Where("space_id = ? AND user_id = ?", *id, u.ID).
				Limit(1).Find(&m).Error; err != nil {
				return err
			}
			if len(m) == 0 {
				return errSpaceNotFound
			}
		}
		return tx.Model(&model.User{}).Where("id = ?", u.ID).UpdateColumn("default_space_id", value).Error
	})
	if err != nil {
		return err
	}
	u.DefaultSpaceID = id
	return h.getMe(c)
}
