// Package service contains TripHub business logic shared by HTTP handlers:
// permissions, experience/levels, notifications, trip & place statistics,
// footprints, and the travel-mode features (check-in, compare, recommend, AI plan).
package service

import (
	"context"
	"fmt"
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
// serialising waypoint ordering changes and counter recounts.
func LockTrip(tx *gorm.DB, tripID int64) error {
	return tx.Exec("SELECT id FROM trips WHERE id = ? FOR UPDATE", tripID).Error
}

// LockPlace takes a row lock on a place for the remainder of the transaction,
// serialising comment_count recounts.
func LockPlace(tx *gorm.DB, placeID int64) error {
	return tx.Exec("SELECT id FROM places WHERE id = ? FOR UPDATE", placeID).Error
}

// Results of SeedAdmin.
const (
	SeedCreated  = "created"  // the admin account was created
	SeedPromoted = "promoted" // an existing user with the configured password was made admin
	SeedExists   = "exists"   // the admin exists; the configured password differs and was not applied
	SeedConflict = "conflict" // a normal user has the name but another password: nothing changed
)

// SeedAdmin creates the configured admin account when it does not exist; the
// password must meet the password policy (auth.ValidatePassword), so the
// placeholder of the example configuration never becomes a real login.
// An existing account is never changed silently: a normal user is promoted
// only when the configured password matches its own (proving the operator
// owns it), and an existing admin's password is never overwritten. It
// returns one of the Seed* results, or "" when there was nothing to do.
func (s *Service) SeedAdmin(ctx context.Context, username, password string) (string, error) {
	if username == "" || password == "" {
		return "", nil
	}
	db := s.DB.WithContext(ctx)
	var u model.User
	err := db.Where("lower(username) = lower(?)", username).First(&u).Error
	if err == nil {
		match := auth.CheckPassword(u.PasswordHash, password)
		switch {
		case u.Role == model.RoleAdmin && match:
			return "", nil
		case u.Role == model.RoleAdmin:
			return SeedExists, nil
		case !match:
			return SeedConflict, nil
		}
		return SeedPromoted, db.Model(&u).Update("role", model.RoleAdmin).Error
	}
	if err != gorm.ErrRecordNotFound {
		return "", err
	}
	if err := auth.ValidatePassword(password); err != nil {
		return "", fmt.Errorf("管理员密码 TRIPHUB_ADMIN_PASSWORD 不符合要求：%v（请修改 .env 中的 ADMIN_PASSWORD 后重启）", err)
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return "", err
	}
	u = model.User{Username: username, Nickname: username, PasswordHash: hash, Role: model.RoleAdmin, Status: model.UserActive}
	if err := db.Create(&u).Error; err != nil {
		return "", err
	}
	return SeedCreated, nil
}

// ResetPassword sets a user's password and signs them out everywhere
// (deletes all their refresh tokens).
func ResetPassword(ctx context.Context, db *gorm.DB, userID int64, password string) error {
	hash, err := auth.HashPassword(password)
	if err != nil {
		return err
	}
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&model.User{}).Where("id = ?", userID).Update("password_hash", hash).Error; err != nil {
			return err
		}
		return tx.Where("user_id = ?", userID).Delete(&model.RefreshToken{}).Error
	})
}
