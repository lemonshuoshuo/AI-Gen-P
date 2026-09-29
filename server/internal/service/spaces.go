package service

import (
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"triphub/internal/model"
)

// Spaces (空间) group users who share trips: every member of a space may
// open and edit the trips linked to it (model.Trip.SpaceID) like an accepted
// co-author (see TripAccess). Lock order, to keep concurrent changes free of
// deadlocks: users (LockUser), then spaces (LockSpace), then trips.

// Space limits.
const (
	MaxSpacesPerUser = 20 // spaces a user may belong to (as owner or member)
	MaxSpaceMembers  = 50 // members of a space, pending invites included (couple spaces: 2)
)

// SpaceTypes maps the built-in space types to their display names; a custom
// space (model.SpaceCustom) shows its own TypeLabel.
var SpaceTypes = map[string]string{
	model.SpaceCouple:  "情侣",
	model.SpaceBesties: "闺蜜",
	model.SpaceFriends: "朋友",
	model.SpaceFamily:  "家人",
}

// ValidSpaceType reports whether t is a space type.
func ValidSpaceType(t string) bool {
	_, ok := SpaceTypes[t]
	return ok || t == model.SpaceCustom
}

// SpaceTypeLabel is the display name of a space's type.
func SpaceTypeLabel(sp *model.Space) string {
	if sp.Type == model.SpaceCustom {
		return sp.TypeLabel
	}
	return SpaceTypes[sp.Type]
}

// DefaultSpaceName names a space created without a name.
func DefaultSpaceName(typ, label string) string {
	switch typ {
	case model.SpaceCouple:
		return "我们"
	case model.SpaceCustom:
		return label
	}
	return SpaceTypes[typ] + "们"
}

// SpaceCapacity is the most members (pending invites included) a space of
// type typ may have.
func SpaceCapacity(typ string) int {
	if typ == model.SpaceCouple {
		return 2
	}
	return MaxSpaceMembers
}

// SpaceIDsOf is a subquery selecting the spaces a user belongs to.
func SpaceIDsOf(db *gorm.DB, userID int64) *gorm.DB {
	return db.Model(&model.SpaceMember{}).Select("space_id").Where("user_id = ?", userID)
}

// SpaceTripIDs is a subquery selecting the trips linked to a space.
func SpaceTripIDs(db *gorm.DB, spaceID int64) *gorm.DB {
	return db.Model(&model.Trip{}).Select("id").Where("space_id = ?", spaceID)
}

// SpaceMembership returns userID's membership of a space (nil: not a member).
func SpaceMembership(db *gorm.DB, spaceID, userID int64) (*model.SpaceMember, error) {
	var m model.SpaceMember
	if err := db.Where("space_id = ? AND user_id = ?", spaceID, userID).Limit(1).Find(&m).Error; err != nil || m.UserID == 0 {
		return nil, err
	}
	return &m, nil
}

// LockUser locks a user's row for the rest of the transaction: it
// serialises the changes of the spaces the user belongs to (the number of
// spaces, the single couple space).
func LockUser(tx *gorm.DB, userID int64) error {
	return tx.Exec("SELECT id FROM users WHERE id = ? FOR UPDATE", userID).Error
}

// LockSpace locks a space's row for the rest of the transaction and loads
// it (nil: it does not exist). Every change of a space's members, invites
// or linked trips holds it.
func LockSpace(tx *gorm.DB, spaceID int64) (*model.Space, error) {
	var sp model.Space
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ?", spaceID).Limit(1).Find(&sp).Error; err != nil || sp.ID == 0 {
		return nil, err
	}
	return &sp, nil
}

// ShareLockSpace is LockSpace for linking a trip to the space: it keeps the
// space and its members as they are (FOR SHARE) until the transaction ends,
// without blocking other trips being linked at the same time.
func ShareLockSpace(tx *gorm.DB, spaceID int64) (*model.Space, error) {
	var sp model.Space
	if err := tx.Clauses(clause.Locking{Strength: "SHARE"}).Where("id = ?", spaceID).Limit(1).Find(&sp).Error; err != nil || sp.ID == 0 {
		return nil, err
	}
	return &sp, nil
}

// CouplePartners maps each of userIDs who has a partner (the other member
// of their couple space) to that partner.
func CouplePartners(db *gorm.DB, userIDs []int64) (map[int64]int64, error) {
	out := map[int64]int64{}
	ids := uniqueIDs(userIDs)
	if len(ids) == 0 {
		return out, nil
	}
	var rows []struct{ UserID, PartnerID int64 }
	if err := db.Raw(`SELECT a.user_id, b.user_id AS partner_id FROM space_members a
JOIN space_members b ON b.space_id = a.space_id AND b.user_id <> a.user_id
WHERE a.couple AND a.user_id IN ?`, ids).Scan(&rows).Error; err != nil {
		return nil, err
	}
	for _, r := range rows {
		out[r.UserID] = r.PartnerID
	}
	return out, nil
}

// unlinkTrips removes trips from their space, counting a revision of each
// (the trips' members change).
func unlinkTrips(tx *gorm.DB, ids []int64, actorID int64) error {
	if len(ids) == 0 {
		return nil
	}
	if err := TouchTrips(tx, ids, actorID); err != nil {
		return err
	}
	return tx.Model(&model.Trip{}).Where("id IN ?", ids).UpdateColumn("space_id", gorm.Expr("NULL")).Error
}

// SpaceLeft is what RemoveSpaceMember did.
type SpaceLeft struct {
	NewOwnerID int64   // the member who became the owner (0: the owner did not change)
	Deleted    bool    // the last member left: the space was deleted
	Unlinked   []int64 // the leaving member's trips, no longer in the space
}

// RemoveSpaceMember takes userID (a member) out of space sp, locked by the
// caller (LockSpace): the trips they own leave the space (they keep them),
// the invites they sent to it are withdrawn and it stops being their
// default space. When they owned it, the member who joined earliest becomes
// the owner; when they were the last member, the space is deleted. actorID
// is who made the change (for the trips' revisions).
func RemoveSpaceMember(tx *gorm.DB, sp *model.Space, userID, actorID int64) (*SpaceLeft, error) {
	out := &SpaceLeft{}
	if err := tx.Where("space_id = ? AND user_id = ?", sp.ID, userID).Delete(&model.SpaceMember{}).Error; err != nil {
		return nil, err
	}
	if err := tx.Model(&model.Trip{}).Where("space_id = ? AND owner_id = ?", sp.ID, userID).Order("id").
		Pluck("id", &out.Unlinked).Error; err != nil {
		return nil, err
	}
	if err := unlinkTrips(tx, out.Unlinked, actorID); err != nil {
		return nil, err
	}
	if err := tx.Model(&model.SpaceInvite{}).Where("space_id = ? AND inviter_id = ? AND status = ?", sp.ID, userID, model.InvitePending).
		Update("status", model.InviteCancelled).Error; err != nil {
		return nil, err
	}
	if err := tx.Model(&model.User{}).Where("id = ? AND default_space_id = ?", userID, sp.ID).
		UpdateColumn("default_space_id", gorm.Expr("NULL")).Error; err != nil {
		return nil, err
	}
	if sp.OwnerID != userID {
		return out, nil
	}
	var next model.SpaceMember
	if err := tx.Where("space_id = ?", sp.ID).Order("joined_at, user_id").Limit(1).Find(&next).Error; err != nil {
		return nil, err
	}
	if next.UserID == 0 {
		if _, err := DeleteSpace(tx, sp.ID, actorID); err != nil {
			return nil, err
		}
		out.Deleted = true
		return out, nil
	}
	if err := tx.Model(&model.Space{}).Where("id = ?", sp.ID).Updates(map[string]any{"owner_id": next.UserID, "updated_at": time.Now()}).Error; err != nil {
		return nil, err
	}
	if err := tx.Model(&model.SpaceMember{}).Where("space_id = ? AND user_id = ?", sp.ID, next.UserID).
		Update("role", model.SpaceRoleOwner).Error; err != nil {
		return nil, err
	}
	sp.OwnerID, out.NewOwnerID = next.UserID, next.UserID
	return out, nil
}

// DeleteSpace deletes a space, locked by the caller (LockSpace): its trips
// stay with their owners, unlinked (each counting a revision), its pending
// invites are withdrawn and it stops being anyone's default space. It
// returns who its members were (earliest first).
func DeleteSpace(tx *gorm.DB, spaceID, actorID int64) ([]int64, error) {
	var members, trips []int64
	if err := tx.Model(&model.SpaceMember{}).Where("space_id = ?", spaceID).Order("joined_at, user_id").
		Pluck("user_id", &members).Error; err != nil {
		return nil, err
	}
	if err := tx.Model(&model.Trip{}).Where("space_id = ?", spaceID).Order("id").Pluck("id", &trips).Error; err != nil {
		return nil, err
	}
	if err := unlinkTrips(tx, trips, actorID); err != nil {
		return nil, err
	}
	// The memberships go before the defaults are cleared: setting a default
	// space holds its membership (FOR SHARE) until it commits.
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{"UPDATE space_invites SET status = ?, updated_at = now() WHERE space_id = ? AND status = ?",
			[]any{model.InviteCancelled, spaceID, model.InvitePending}},
		{"DELETE FROM space_members WHERE space_id = ?", []any{spaceID}},
		{"UPDATE users SET default_space_id = NULL WHERE default_space_id = ?", []any{spaceID}},
		{"DELETE FROM spaces WHERE id = ?", []any{spaceID}},
	} {
		if err := tx.Exec(q.sql, q.args...).Error; err != nil {
			return nil, err
		}
	}
	return members, nil
}

// spaceTripOrder orders a space's trips latest first: by start date, or
// the day they were created when they have no dates.
const spaceTripOrder = "COALESCE(start_date, (created_at AT TIME ZONE 'Asia/Shanghai')::date) DESC, created_at DESC, id DESC"

// SpaceTripOrder is the order of GET /spaces/:id/trips (and of the latest
// trip in GET /spaces).
func SpaceTripOrder() string { return spaceTripOrder }

// SpaceCounts are the trips and cities of a space (GET /spaces).
type SpaceCounts struct {
	Trips  int // linked trips
	Cities int // cities of the visited stops of its trips (as footprints count them)
	// LastTripID is the latest trip (in SpaceTripOrder; 0: none).
	LastTripID int64
	// PendingInvites counts the space's invites awaiting an answer.
	PendingInvites int
}

// SpaceCountsOf computes the SpaceCounts of spaces.
func SpaceCountsOf(db *gorm.DB, spaceIDs []int64) (map[int64]*SpaceCounts, error) {
	out := map[int64]*SpaceCounts{}
	ids := uniqueIDs(spaceIDs)
	for _, id := range ids {
		out[id] = &SpaceCounts{}
	}
	if len(ids) == 0 {
		return out, nil
	}
	type count struct {
		SpaceID int64
		N       int
	}
	var trips, cities, invites []count
	if err := db.Model(&model.Trip{}).Select("space_id, COUNT(*) AS n").Where("space_id IN ?", ids).Group("space_id").
		Scan(&trips).Error; err != nil {
		return nil, err
	}
	for _, r := range trips {
		out[r.SpaceID].Trips = r.N
	}
	if err := db.Raw(`SELECT t.space_id, COUNT(DISTINCT w.city_code) AS n FROM waypoints w JOIN trips t ON t.id = w.trip_id
WHERE t.space_id IN ? AND w.status = ? AND w.city_code <> '' GROUP BY t.space_id`, ids, model.WPVisited).Scan(&cities).Error; err != nil {
		return nil, err
	}
	for _, r := range cities {
		out[r.SpaceID].Cities = r.N
	}
	if err := db.Model(&model.SpaceInvite{}).Select("space_id, COUNT(*) AS n").Where("space_id IN ? AND status = ?", ids, model.InvitePending).
		Group("space_id").Scan(&invites).Error; err != nil {
		return nil, err
	}
	for _, r := range invites {
		out[r.SpaceID].PendingInvites = r.N
	}
	var last []struct{ SpaceID, ID int64 }
	if err := db.Raw(`SELECT DISTINCT ON (space_id) space_id, id FROM trips WHERE space_id IN ? ORDER BY space_id, `+spaceTripOrder, ids).
		Scan(&last).Error; err != nil {
		return nil, err
	}
	for _, r := range last {
		out[r.SpaceID].LastTripID = r.ID
	}
	return out, nil
}
