package service

import (
	"strings"

	"gorm.io/gorm"

	"triphub/internal/geo"
	"triphub/internal/model"
)

// SameLodging reports whether two waypoints are the same hotel: the same
// AMap POI or place, or the same name within 100 m.
func SameLodging(a, b *model.Waypoint) bool {
	switch {
	case a.AmapID != "" && a.AmapID == b.AmapID:
		return true
	case a.PlaceID != nil && b.PlaceID != nil && *a.PlaceID == *b.PlaceID:
		return true
	}
	return strings.EqualFold(strings.TrimSpace(a.Name), strings.TrimSpace(b.Name)) &&
		geo.Haversine(a.Lng, a.Lat, b.Lng, b.Lat) <= 100
}

// ShrinkDays fits a trip's waypoints into days days, when its days are cut
// (fewer planned days, or a shorter date range): stops of later days move
// to day 0 (未分天), and the lodging of later nights (night > days; the
// night after the last day stays) is deleted when the same hotel remains on
// another night, else it becomes a 未分天 stop, so that nothing the user
// entered is lost. Photos and comments of deleted lodging are kept,
// unlinked. The caller holds the trip lock, then recomputes the trip and
// the returned places.
func ShrinkDays(tx *gorm.DB, tripID int64, days int) ([]int64, error) {
	if err := tx.Model(&model.Waypoint{}).Where("trip_id = ? AND kind <> ? AND day > ?", tripID, model.KindLodging, days).
		Update("day", 0).Error; err != nil {
		return nil, err
	}
	var lodging []model.Waypoint
	if err := tx.Where("trip_id = ? AND kind = ?", tripID, model.KindLodging).Order("day, seq, id").Find(&lodging).Error; err != nil {
		return nil, err
	}
	var kept []*model.Waypoint
	var gone []int64
	var placeIDs []int64
	for i := range lodging {
		w := &lodging[i]
		if w.Day <= days {
			kept = append(kept, w)
			continue
		}
		dup := false
		for _, k := range kept {
			if SameLodging(w, k) {
				dup = true
				break
			}
		}
		if dup {
			gone = append(gone, w.ID)
			placeIDs = append(placeIDs, PlaceIDs(w.PlaceID)...)
			continue
		}
		if err := tx.Model(&model.Waypoint{}).Where("id = ?", w.ID).
			Updates(map[string]any{"kind": model.KindStop, "day": 0}).Error; err != nil {
			return nil, err
		}
		kept = append(kept, w) // later nights at this hotel are duplicates of it
	}
	if len(gone) == 0 {
		return placeIDs, nil
	}
	if err := DeleteWaypoints(tx, tripID, gone); err != nil {
		return nil, err
	}
	return placeIDs, nil
}

// DeleteWaypoints deletes waypoints of a trip, unlinking their photos and
// comments, and renumbers the trip's seq. The caller holds the trip lock.
func DeleteWaypoints(tx *gorm.DB, tripID int64, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	if err := tx.Model(&model.Photo{}).Where("waypoint_id IN ?", ids).Update("waypoint_id", nil).Error; err != nil {
		return err
	}
	if err := tx.Model(&model.Comment{}).Where("waypoint_id IN ?", ids).Update("waypoint_id", nil).Error; err != nil {
		return err
	}
	if err := tx.Where("trip_id = ? AND id IN ?", tripID, ids).Delete(&model.Waypoint{}).Error; err != nil {
		return err
	}
	return CompactSeq(tx, tripID)
}

// LodgingSeq is where a lodging of night belongs in a trip's order (the
// ids in seq order and the day of each): after the last waypoint of days
// 1..night, else before the first of a later day, else at the end. Where a
// lodging is stored does not matter for the routes (see PlanOrder); this
// keeps lists by seq tidy.
func LodgingSeq(ids []int64, dayOf map[int64]int, night int) int {
	after := -1
	for i, id := range ids {
		if d := dayOf[id]; d >= 1 && d <= night {
			after = i
		}
	}
	if after >= 0 {
		return after + 1
	}
	for i, id := range ids {
		if dayOf[id] > night {
			return i
		}
	}
	return len(ids)
}
