// Package db connects to Postgres and migrates the schema.
package db

import (
	"context"
	"fmt"
	"log"
	"log/slog"
	"os"
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
		gdb, err := gorm.Open(postgres.Open(dsn), &gorm.Config{Logger: gl, TranslateError: true})
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

// Migrate creates / updates all tables and extra indexes.
func Migrate(gdb *gorm.DB) error {
	if err := gdb.AutoMigrate(model.All()...); err != nil {
		return fmt.Errorf("auto migrate: %w", err)
	}
	stmts := []string{
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (lower(username))`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email)) WHERE email <> ''`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_places_amap_id ON places (amap_id) WHERE amap_id <> ''`,
		`CREATE INDEX IF NOT EXISTS idx_trips_tags ON trips USING gin (tags)`,
		`CREATE INDEX IF NOT EXISTS idx_comments_parent_created ON comments (parent_id, created_at)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_pending_pair ON partner_invites (from_id, to_id) WHERE status = 'pending'`,
	}
	for _, s := range stmts {
		if err := gdb.Exec(s).Error; err != nil {
			return fmt.Errorf("migrate %q: %w", s, err)
		}
	}
	return nil
}
