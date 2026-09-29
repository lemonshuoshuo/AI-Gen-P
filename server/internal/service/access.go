package service

import (
	"crypto/subtle"

	"gorm.io/gorm"

	"triphub/internal/model"
)

// Access describes what a viewer may do with a trip.
type Access struct {
	UserID int64
	Admin  bool
	Owner  bool
	// Member: an accepted member (owner included), or a member of the space
	// the trip is linked to (ViaSpace), who has exactly the same rights as
	// an accepted co-author.
	Member   bool
	ViaSpace bool // Member only through the trip's space (Trip.SpaceID)
	Pending  bool // invited but not yet accepted
	ViaShare bool // presented the correct share code
}

// CanView applies the visibility rules:
//   - members, invitees and admins always;
//   - hidden trips: nobody else;
//   - public trips: everyone;
//   - unlisted trips: anyone holding the share code.
func (a Access) CanView(t *model.Trip) bool {
	if a.Admin || a.Member || a.Pending {
		return true
	}
	if t.Status != model.TripNormal {
		return false
	}
	switch t.Visibility {
	case model.VisPublic:
		return true
	case model.VisUnlisted:
		return a.ViaShare
	}
	return false
}

// CanEdit reports whether the viewer may edit trip content.
func (a Access) CanEdit() bool { return a.Member }

// HideLive reports whether the trip's actual-travel data (GPS track,
// check-ins, arrival times, photos) must be hidden from the viewer: while a
// trip is ongoing only members and admins see it, unless the owner turned on
// live sharing. Share-code visitors are not exempt.
func (a Access) HideLive(t *model.Trip) bool {
	return t.Phase == model.PhaseOngoing && !t.LiveShare && !a.Member && !a.Admin
}

// TripAccess resolves a viewer's relation to a trip. user may be nil (guest).
// t needs ID, OwnerID, Visibility, ShareCode and SpaceID.
func (s *Service) TripAccess(db *gorm.DB, t *model.Trip, user *model.User, shareCode string) (Access, error) {
	if user == nil || t.OwnerID == user.ID {
		return AccessFrom(t, user, shareCode, "", false), nil
	}
	if t.SpaceID == nil {
		var m model.TripMember
		if err := db.Where("trip_id = ? AND user_id = ?", t.ID, user.ID).Limit(1).Find(&m).Error; err != nil {
			return Access{}, err
		}
		return AccessFrom(t, user, shareCode, m.Status, false), nil
	}
	var row struct {
		MemberStatus *string
		InSpace      bool
	}
	if err := db.Raw(`SELECT (SELECT status FROM trip_members WHERE trip_id = ? AND user_id = ? LIMIT 1) AS member_status,
  EXISTS (SELECT 1 FROM space_members WHERE space_id = ? AND user_id = ?) AS in_space`,
		t.ID, user.ID, *t.SpaceID, user.ID).Scan(&row).Error; err != nil {
		return Access{}, err
	}
	status := ""
	if row.MemberStatus != nil {
		status = *row.MemberStatus
	}
	return AccessFrom(t, user, shareCode, status, row.InSpace), nil
}

// AccessFrom is TripAccess for a caller that has already read the status
// of user's membership row of the trip ("" when there is none) and whether
// user is a member of the space the trip is linked to (inSpace). t needs
// OwnerID, Visibility, ShareCode and SpaceID.
func AccessFrom(t *model.Trip, user *model.User, shareCode, memberStatus string, inSpace bool) Access {
	a := Access{}
	if shareCode != "" && t.Visibility != model.VisPrivate &&
		subtle.ConstantTimeCompare([]byte(shareCode), []byte(t.ShareCode)) == 1 {
		a.ViaShare = true
	}
	if user == nil {
		return a
	}
	a.UserID = user.ID
	a.Admin = user.IsAdmin()
	a.Owner = t.OwnerID == user.ID
	if a.Owner {
		a.Member = true
		return a
	}
	a.Member = memberStatus == model.MemberAccepted
	a.Pending = memberStatus == model.MemberPending
	if !a.Member && inSpace && t.SpaceID != nil {
		a.Member, a.ViaSpace = true, true
	}
	return a
}

// MemberTripIDs is a subquery selecting trips where the user is an accepted
// member (author or co-author): the trips they take part in, which their
// own lists and footprints show. See AccessibleTripIDs for the trips they
// may open and edit.
func MemberTripIDs(db *gorm.DB, userID int64) *gorm.DB {
	return db.Model(&model.TripMember{}).Select("trip_id").Where("user_id = ? AND status = ?", userID, model.MemberAccepted)
}

// AccessibleTripIDs is a subquery selecting the trips the user may open and
// edit as a member (Access.Member): those where they are an accepted member,
// and those linked to a space they belong to.
func AccessibleTripIDs(db *gorm.DB, userID int64) *gorm.DB {
	return db.Raw(`SELECT trip_id FROM trip_members WHERE user_id = ? AND status = ?
UNION SELECT id FROM trips WHERE space_id IN (SELECT space_id FROM space_members WHERE user_id = ?)`,
		userID, model.MemberAccepted, userID)
}

// VisibleMemberTripIDs is AccessibleTripIDs plus the trips the user is
// invited to (a pending co-author, who may preview the trip).
func VisibleMemberTripIDs(db *gorm.DB, userID int64) *gorm.DB {
	return db.Raw(`SELECT trip_id FROM trip_members WHERE user_id = ? AND status IN ?
UNION SELECT id FROM trips WHERE space_id IN (SELECT space_id FROM space_members WHERE user_id = ?)`,
		userID, []string{model.MemberAccepted, model.MemberPending}, userID)
}

// PartnerOf returns the couple space of a user (nil: none) and their
// partner in it (0 while the space has no second member).
func PartnerOf(db *gorm.DB, userID int64) (int64, *model.Space, error) {
	var sp model.Space
	if err := db.Where("id = (SELECT space_id FROM space_members WHERE user_id = ? AND couple LIMIT 1)", userID).
		Limit(1).Find(&sp).Error; err != nil || sp.ID == 0 {
		return 0, nil, err
	}
	var others []int64
	if err := db.Model(&model.SpaceMember{}).Where("space_id = ? AND user_id <> ?", sp.ID, userID).
		Order("user_id").Limit(1).Pluck("user_id", &others).Error; err != nil {
		return 0, nil, err
	}
	if len(others) == 0 {
		return 0, &sp, nil
	}
	return others[0], &sp, nil
}
