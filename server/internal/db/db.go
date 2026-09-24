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
	}
	for _, s := range stmts {
		if err := gdb.Exec(s).Error; err != nil {
			return fmt.Errorf("migrate %q: %w", s, err)
		}
	}
	return nil
}
