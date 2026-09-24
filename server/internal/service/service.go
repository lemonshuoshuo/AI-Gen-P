// Package service contains TripHub business logic shared by HTTP handlers:
// permissions, experience/levels, notifications, trip & place statistics,
// footprints, and the travel-mode features (check-in, compare, recommend, AI plan).
package service

import (
	"context"
	"time"

	"gorm.io/gorm"

	"triphub/internal/ai"
	"triphub/internal/amap"
	"triphub/internal/auth"
	"triphub/internal/config"
	"triphub/internal/geo"
	"triphub/internal/media"
	"triphub/internal/model"
)

// Service bundles dependencies used by business logic.
type Service struct {
	DB       *gorm.DB
	Cfg      *config.Config
	Atlas    *geo.Atlas
	Amap     *amap.Client
	AI       *ai.Client
	Media    *media.Store
	Settings *Settings
	Loc      *time.Location
}

// New creates a Service.
func New(db *gorm.DB, cfg *config.Config, atlas *geo.Atlas, am *amap.Client, aic *ai.Client, store *media.Store, settings *Settings, loc *time.Location) *Service {
	return &Service{DB: db, Cfg: cfg, Atlas: atlas, Amap: am, AI: aic, Media: store, Settings: settings, Loc: loc}
}

// NewShareCode returns a fresh 10-character base62 share code.
func NewShareCode() string { return auth.RandomBase62(10) }

// LockTrip takes a row lock on a trip for the remainder of the transaction,
// serialising waypoint ordering changes.
func LockTrip(tx *gorm.DB, tripID int64) error {
	return tx.Exec("SELECT id FROM trips WHERE id = ? FOR UPDATE", tripID).Error
}

// SeedAdmin creates or promotes the configured admin account.
func (s *Service) SeedAdmin(ctx context.Context, username, password string) (created bool, err error) {
	if username == "" || password == "" {
		return false, nil
	}
	var u model.User
	err = s.DB.WithContext(ctx).Where("lower(username) = lower(?)", username).First(&u).Error
	if err == nil {
		if u.Role != model.RoleAdmin {
			return false, s.DB.WithContext(ctx).Model(&u).Update("role", model.RoleAdmin).Error
		}
		return false, nil
	}
	if err != gorm.ErrRecordNotFound {
		return false, err
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return false, err
	}
	u = model.User{Username: username, Nickname: username, PasswordHash: hash, Role: model.RoleAdmin, Status: model.UserActive}
	return true, s.DB.WithContext(ctx).Create(&u).Error
}
