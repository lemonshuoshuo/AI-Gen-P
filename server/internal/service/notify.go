package service

import (
	"gorm.io/gorm"

	"triphub/internal/model"
)

// Notice describes a notification to deliver.
type Notice struct {
	UserID    int64
	Type      string
	ActorID   int64
	TripID    int64
	PlaceID   int64
	CommentID int64
	Content   string
}

func ptrOrNil(id int64) *int64 {
	if id == 0 {
		return nil
	}
	return &id
}

// Notify stores a notification. Users are never notified about their own
// actions, and repeated like/favorite/follow notifications are collapsed.
func (s *Service) Notify(tx *gorm.DB, n Notice) error {
	if n.UserID == 0 || (n.ActorID != 0 && n.ActorID == n.UserID) {
		return nil
	}
	switch n.Type {
	case "like", "favorite", "follow":
		var cnt int64
		q := tx.Model(&model.Notification{}).Where("user_id = ? AND type = ? AND actor_id = ?", n.UserID, n.Type, n.ActorID)
		if n.TripID != 0 {
			q = q.Where("trip_id = ?", n.TripID)
		}
		if err := q.Count(&cnt).Error; err != nil {
			return err
		}
		if cnt > 0 {
			return nil
		}
	}
	return tx.Create(&model.Notification{
		UserID: n.UserID, Type: n.Type, ActorID: ptrOrNil(n.ActorID), TripID: ptrOrNil(n.TripID),
		PlaceID: ptrOrNil(n.PlaceID), CommentID: ptrOrNil(n.CommentID), Content: Truncate(n.Content, 200),
	}).Error
}

// Truncate shortens s to at most n runes, appending "…" when cut.
func Truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
