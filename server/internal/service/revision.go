package service

import (
	"slices"

	"gorm.io/gorm"
)

// TouchTrip records a change of a trip (model.Trip.Revision): it increments
// the revision, and sets who made the change (actorID, 0 = unknown) and
// when. Call it in the transaction of every change of the trip or of its
// waypoints, lodging, check-ins, photos or members, so that the change and
// its revision commit together; editors poll the revision (GET
// /trips/:id/revision) to pick up each other's changes, and PUT
// /trips/:id/plan refuses a draft based on an older revision. The row lock
// it takes is the trip lock (LockTrip), which most callers already hold.
// It returns the new revision.
func TouchTrip(tx *gorm.DB, tripID, actorID int64) (int64, error) {
	var rev int64
	err := tx.Raw(`UPDATE trips SET revision = revision + 1, updated_by_id = ?, updated_at = clock_timestamp()
WHERE id = ? RETURNING revision`, actorID, tripID).Scan(&rev).Error
	return rev, err
}

// TouchTrips is TouchTrip for several trips (e.g. the co-authorships a closed
// account or an ended partnership leaves); the rows are locked in id order
// first, as DeleteTrip locks several trips, so that it cannot deadlock with
// another multi-trip change.
func TouchTrips(tx *gorm.DB, ids []int64, actorID int64) error {
	ids = uniqueIDs(ids)
	if len(ids) == 0 {
		return nil
	}
	slices.Sort(ids)
	if err := tx.Exec("SELECT id FROM trips WHERE id IN ? ORDER BY id FOR UPDATE", ids).Error; err != nil {
		return err
	}
	return tx.Exec(`UPDATE trips SET revision = revision + 1, updated_by_id = ?, updated_at = clock_timestamp()
WHERE id IN ?`, actorID, ids).Error
}
