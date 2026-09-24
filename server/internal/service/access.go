package service

import (
	"crypto/subtle"

	"gorm.io/gorm"

	"triphub/internal/model"
)

// Access describes what a viewer may do with a trip.
type Access struct {
	UserID   int64
	Admin    bool
	Owner    bool
	Member   bool // accepted member (owner included)
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
func (s *Service) TripAccess(db *gorm.DB, t *model.Trip, user *model.User, shareCode string) (Access, error) {
	a := Access{}
	if shareCode != "" && t.Visibility != model.VisPrivate &&
		subtle.ConstantTimeCompare([]byte(shareCode), []byte(t.ShareCode)) == 1 {
		a.ViaShare = true
	}
	if user == nil {
		return a, nil
	}
	a.UserID = user.ID
	a.Admin = user.IsAdmin()
	a.Owner = t.OwnerID == user.ID
	if a.Owner {
		a.Member = true
		return a, nil
	}
	var m model.TripMember
	err := db.Where("trip_id = ? AND user_id = ?", t.ID, user.ID).Limit(1).Find(&m).Error
	if err != nil {
		return a, err
	}
	if m.ID != 0 {
		a.Member = m.Status == model.MemberAccepted
		a.Pending = m.Status == model.MemberPending
	}
	return a, nil
}

// MemberTripIDs is a subquery selecting trips where the user is an accepted member.
func MemberTripIDs(db *gorm.DB, userID int64) *gorm.DB {
	return db.Model(&model.TripMember{}).Select("trip_id").Where("user_id = ? AND status = ?", userID, model.MemberAccepted)
}

// PartnerOf returns the partner user ID of a user (0 when not bound).
func PartnerOf(db *gorm.DB, userID int64) (int64, *model.Partnership, error) {
	var p model.Partnership
	err := db.Where("user_a = ? OR user_b = ?", userID, userID).Limit(1).Find(&p).Error
	if err != nil || p.ID == 0 {
		return 0, nil, err
	}
	if p.UserA == userID {
		return p.UserB, &p, nil
	}
	return p.UserA, &p, nil
}
