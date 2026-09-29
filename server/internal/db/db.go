// Package db connects to Postgres and migrates the schema.
package db

import (
	"context"
	"fmt"
	"log"
	"log/slog"
	"os"
	"strings"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"triphub/internal/model"
)

// Open connects to Postgres, retrying for up to `wait` while the database starts.
func Open(ctx context.Context, dsn string, wait time.Duration) (*gorm.DB, error) {
	gl := logger.New(log.New(os.Stderr, "gorm ", log.LstdFlags), logger.Config{
		SlowThreshold:             500 * time.Millisecond,
		LogLevel:                  logger.Warn,
		IgnoreRecordNotFoundError: true,
	})
	deadline := time.Now().Add(wait)
	for {
		// Every GORM write here is a single statement (no associations or
		// hooks), so GORM's implicit BEGIN/COMMIT only adds two round trips.
		// Multi-statement writes must use db.Transaction explicitly.
		gdb, err := gorm.Open(postgres.Open(dsn), &gorm.Config{Logger: gl, TranslateError: true, SkipDefaultTransaction: true})
		if err == nil {
			sqlDB, derr := gdb.DB()
			if derr == nil {
				pctx, cancel := context.WithTimeout(ctx, 3*time.Second)
				derr = sqlDB.PingContext(pctx)
				cancel()
			}
			if derr == nil {
				sqlDB.SetMaxOpenConns(30)
				sqlDB.SetMaxIdleConns(10)
				sqlDB.SetConnMaxLifetime(30 * time.Minute)
				return gdb, nil
			}
			if sqlDB != nil {
				_ = sqlDB.Close()
			}
			err = derr
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("connect database: %w", err)
		}
		slog.Warn("database not ready, retrying", "err", err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// floatColumns are the float64 columns, which GORM's postgres driver created
// as numeric before the models declared them double precision.
var floatColumns = []struct {
	table string
	cols  []string
}{
	{"trips", []string{"distance_km", "track_distance_km"}},
	{"waypoints", []string{"lng", "lat", "cost"}},
	{"photos", []string{"lng", "lat"}},
	{"track_points", []string{"lng", "lat", "alt", "acc", "speed"}},
	{"track_stats", []string{"distance_m"}},
	{"places", []string{"lng", "lat", "rating_avg", "avg_cost"}},
}

// convertNumericFloats changes the floatColumns still stored as numeric to
// double precision, rewriting each table once. AutoMigrate cannot be relied
// on for this: it skips the type change of columns that have a default.
func convertNumericFloats(gdb *gorm.DB) error {
	for _, t := range floatColumns {
		var found []string
		if err := gdb.Raw(`SELECT column_name FROM information_schema.columns
WHERE table_schema = current_schema() AND table_name = ? AND column_name IN ? AND data_type = 'numeric'
ORDER BY ordinal_position`, t.table, t.cols).Scan(&found).Error; err != nil {
			return fmt.Errorf("find numeric columns of %s: %w", t.table, err)
		}
		if len(found) == 0 {
			continue
		}
		alters := make([]string, len(found))
		for i, c := range found {
			alters[i] = `ALTER COLUMN "` + c + `" TYPE double precision`
		}
		slog.Info("converting numeric columns to double precision", "table", t.table, "columns", found)
		if err := gdb.Exec(`ALTER TABLE "` + t.table + `" ` + strings.Join(alters, ", ")).Error; err != nil {
			return fmt.Errorf("convert %s columns to double precision: %w", t.table, err)
		}
	}
	return nil
}

// Migrate creates / updates all tables and extra indexes.
func Migrate(gdb *gorm.DB) error {
	if err := convertNumericFloats(gdb); err != nil {
		return err
	}
	if err := gdb.AutoMigrate(model.All()...); err != nil {
		return fmt.Errorf("auto migrate: %w", err)
	}
	// IF NOT EXISTS never alters an existing index; give it a new name when
	// changing its definition.
	stmts := []string{
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (lower(username))`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email)) WHERE email <> ''`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_places_amap_id ON places (amap_id) WHERE amap_id <> ''`,
		`CREATE INDEX IF NOT EXISTS idx_trips_tags ON trips USING gin (tags)`,
		`CREATE INDEX IF NOT EXISTS idx_comments_parent_created ON comments (parent_id, created_at)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_pending_pair ON partner_invites (from_id, to_id) WHERE status = 'pending'`,
		`CREATE INDEX IF NOT EXISTS idx_exp_logs_user_created ON exp_logs (user_id, created_at)`,
		// The 精选 tab (GET /trips?tab=featured); matches its ORDER BY exactly.
		`CREATE INDEX IF NOT EXISTS idx_trips_featured ON trips (featured_at DESC NULLS LAST, id DESC) WHERE featured`,
		// The 避雷榜 (GET /places?sort=avoid) and its count.
		`CREATE INDEX IF NOT EXISTS idx_places_avoid_rank ON places (avoid_count DESC, id DESC) WHERE checkin_count > 0 AND avoid_count > 0`,
		// Notification listing by recency; like/favorite/follow/fork de-dup lookup
		// (not partial: cached generic plans could not use a partial index there).
		`CREATE INDEX IF NOT EXISTS idx_notif_user_id ON notifications (user_id, id)`,
		`CREATE INDEX IF NOT EXISTS idx_notif_user_actor ON notifications (user_id, actor_id)`,
		// Idempotency keys of check-ins and photo uploads (client_id), so a request re-sent
		// by an offline queue after a lost response is answered with the first result.
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_waypoints_client_id ON waypoints (trip_id, client_id) WHERE client_id <> ''`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_photos_client_id ON photos (trip_id, client_id) WHERE client_id <> ''`,
		// At most one lodging per trip and night (checked by the handlers too, with a clear message).
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_waypoints_lodging_night ON waypoints (trip_id, day) WHERE kind = 'lodging'`,
		// Everyone is in at most one couple space; one pending invite per space and invitee
		// (both checked by the handlers too, with a clear message).
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_space_members_couple ON space_members (user_id) WHERE couple`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_space_invites_pending ON space_invites (space_id, invitee_id) WHERE status = 'pending'`,
	}
	for _, s := range stmts {
		if err := gdb.Exec(s).Error; err != nil {
			return fmt.Errorf("migrate %q: %w", s, err)
		}
	}
	if err := migratePartnerSpaces(gdb); err != nil {
		return fmt.Errorf("migrate partners to couple spaces: %w", err)
	}
	return nil
}

// migratePartnerSpaces turns the couples of older versions (partnerships)
// into couple spaces, once each (Partnership.SpaceID records it): a space
// named after the couple's space title (「我们」 by default) with both
// partners, owned by the one who sent the invitation (else the lower user
// ID), keeping the anniversary and whether the relationship is public. Their
// shared trips (owned by one, the other an accepted co-author) are linked to
// it, and it becomes both partners' default space unless they have one.
// Pending couple invitations become invitations to the inviter's couple
// space (created for it when needed). Nothing is counted as a trip change.
func migratePartnerSpaces(gdb *gorm.DB) error {
	var parts []model.Partnership
	if err := gdb.Where("space_id IS NULL").Order("id").Find(&parts).Error; err != nil {
		return err
	}
	var invs []model.PartnerInvite
	if err := gdb.Where("status = ? AND space_invite_id IS NULL", model.InvitePending).Order("id").Find(&invs).Error; err != nil {
		return err
	}
	if len(parts) == 0 && len(invs) == 0 {
		return nil
	}
	return gdb.Transaction(func(tx *gorm.DB) error {
		// coupleSpace returns the couple space of a user (0: none) and its member count.
		coupleSpace := func(uid int64) (int64, int, error) {
			var row struct {
				SpaceID int64
				N       int
			}
			err := tx.Raw(`SELECT m.space_id, (SELECT COUNT(*) FROM space_members x WHERE x.space_id = m.space_id) AS n
FROM space_members m WHERE m.user_id = ? AND m.couple LIMIT 1`, uid).Scan(&row).Error
			return row.SpaceID, row.N, err
		}
		for _, p := range parts {
			a, b := p.UserA, p.UserB
			busy := false
			for _, uid := range []int64{a, b} {
				sid, _, err := coupleSpace(uid)
				if err != nil {
					return err
				}
				busy = busy || sid != 0
			}
			if busy { // cannot happen (one partnership per user); left for an operator to look at
				slog.Warn("partnership not migrated: a partner is already in a couple space", "partnership", p.ID)
				continue
			}
			owner := a
			var inviter []int64
			if err := tx.Model(&model.PartnerInvite{}).Where("status = ? AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))",
				model.InviteAccepted, a, b, b, a).Order("id DESC").Limit(1).Pluck("from_id", &inviter).Error; err != nil {
				return err
			}
			if len(inviter) == 1 {
				owner = inviter[0]
			}
			other := b
			if owner == b {
				other = a
			}
			name := []rune(strings.TrimSpace(p.Title))
			if len(name) == 0 {
				name = []rune("我们")
			}
			if len(name) > 30 {
				name = name[:30]
			}
			sp := model.Space{Name: string(name), Type: model.SpaceCouple, OwnerID: owner, Anniversary: p.Since, Public: p.Public,
				CreatedAt: p.BoundAt, UpdatedAt: p.BoundAt}
			if err := tx.Create(&sp).Error; err != nil {
				return err
			}
			if err := tx.Create([]model.SpaceMember{
				{SpaceID: sp.ID, UserID: owner, Role: model.SpaceRoleOwner, JoinedAt: p.BoundAt, Couple: true},
				{SpaceID: sp.ID, UserID: other, Role: model.SpaceRoleMember, JoinedAt: p.BoundAt, Couple: true},
			}).Error; err != nil {
				return err
			}
			if err := tx.Exec(`UPDATE trips SET space_id = ? WHERE space_id IS NULL AND (
  (owner_id = ? AND id IN (SELECT trip_id FROM trip_members WHERE user_id = ? AND status = ?)) OR
  (owner_id = ? AND id IN (SELECT trip_id FROM trip_members WHERE user_id = ? AND status = ?)))`,
				sp.ID, a, b, model.MemberAccepted, b, a, model.MemberAccepted).Error; err != nil {
				return err
			}
			if err := tx.Exec("UPDATE users SET default_space_id = ? WHERE id IN (?, ?) AND default_space_id IS NULL", sp.ID, a, b).Error; err != nil {
				return err
			}
			if err := tx.Model(&model.Partnership{}).Where("id = ?", p.ID).Update("space_id", sp.ID).Error; err != nil {
				return err
			}
		}
		for _, inv := range invs {
			from, fromN, err := coupleSpace(inv.FromID)
			if err != nil {
				return err
			}
			to, toN, err := coupleSpace(inv.ToID)
			if err != nil {
				return err
			}
			var alive int64
			if err := tx.Model(&model.User{}).Where("id IN (?, ?) AND status <> ?", inv.FromID, inv.ToID, model.UserDeleted).
				Count(&alive).Error; err != nil {
				return err
			}
			if fromN >= 2 || (to != 0 && toN >= 2) || alive < 2 || inv.FromID == inv.ToID {
				// One of them has a partner (or is gone): the invitation is over.
				if err := tx.Model(&model.PartnerInvite{}).Where("id = ?", inv.ID).Update("status", model.InviteCanceled).Error; err != nil {
					return err
				}
				continue
			}
			if from == 0 {
				sp := model.Space{Name: "我们", Type: model.SpaceCouple, OwnerID: inv.FromID, CreatedAt: inv.CreatedAt, UpdatedAt: inv.CreatedAt}
				if err := tx.Create(&sp).Error; err != nil {
					return err
				}
				if err := tx.Create(&model.SpaceMember{SpaceID: sp.ID, UserID: inv.FromID, Role: model.SpaceRoleOwner,
					JoinedAt: inv.CreatedAt, Couple: true}).Error; err != nil {
					return err
				}
				from = sp.ID
			}
			var existing []int64
			if err := tx.Model(&model.SpaceInvite{}).Where("space_id = ? AND invitee_id = ? AND status = ?", from, inv.ToID, model.InvitePending).
				Pluck("id", &existing).Error; err != nil {
				return err
			}
			siID := int64(0)
			if len(existing) > 0 {
				siID = existing[0]
			} else {
				si := model.SpaceInvite{SpaceID: from, InviterID: inv.FromID, InviteeID: inv.ToID, Message: inv.Message,
					Status: model.InvitePending, CreatedAt: inv.CreatedAt, UpdatedAt: inv.UpdatedAt}
				if err := tx.Create(&si).Error; err != nil {
					return err
				}
				siID = si.ID
			}
			if err := tx.Model(&model.PartnerInvite{}).Where("id = ?", inv.ID).Update("space_invite_id", siID).Error; err != nil {
				return err
			}
		}
		return nil
	})
}
