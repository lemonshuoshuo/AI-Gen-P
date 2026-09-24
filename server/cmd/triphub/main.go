// Command triphub runs the TripHub server: REST API, uploads and the embedded web UI.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	_ "golang.org/x/crypto/x509roots/fallback" // CA roots for scratch images
	_ "time/tzdata"                            // embedded zoneinfo for scratch images

	"triphub/internal/ai"
	"triphub/internal/amap"
	"triphub/internal/config"
	"triphub/internal/db"
	"triphub/internal/geo"
	"triphub/internal/handler"
	"triphub/internal/media"
	"triphub/internal/service"
	"triphub/internal/version"
	"triphub/internal/webui"
)

func main() {
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println("triphub", version.Version)
		return
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})))
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if err := cfg.Prepare(); err != nil {
		return err
	}
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		return fmt.Errorf("load timezone: %w", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	slog.Info("starting triphub", "version", version.Version, "addr", cfg.Addr, "data_dir", cfg.DataDir,
		"amap", cfg.AmapKey != "", "ai", cfg.AIEnabled())

	gdb, err := db.Open(ctx, cfg.DBDSN, 60*time.Second)
	if err != nil {
		return err
	}
	if err := db.Migrate(gdb); err != nil {
		return err
	}
	atlas, err := geo.DefaultAtlas()
	if err != nil {
		return err
	}
	settings, err := service.LoadSettings(gdb, cfg.SiteName)
	if err != nil {
		return err
	}
	svc := service.New(gdb, cfg, atlas, amap.New(cfg.AmapKey), ai.New(cfg.AIBaseURL, cfg.AIAPIKey, cfg.AIModel, cfg.AITimeout),
		media.NewStore(cfg.UploadDir(), 2), settings, loc)
	if created, err := svc.SeedAdmin(ctx, cfg.AdminUsername, cfg.AdminPassword); err != nil {
		return fmt.Errorf("seed admin: %w", err)
	} else if created {
		slog.Info("admin account created", "username", cfg.AdminUsername)
	}

	gin.SetMode(gin.ReleaseMode)
	h := handler.New(svc, webui.FS())
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           h.Router(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       5 * time.Minute,
		WriteTimeout:      cfg.AITimeout + 2*time.Minute,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    1 << 20,
	}

	go func() {
		t := time.NewTicker(10 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				h.Cleanup()
			}
		}
	}()

	errCh := make(chan error, 1)
	go func() {
		slog.Info("listening", "addr", cfg.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
		close(errCh)
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}
	slog.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return err
	}
	if sqlDB, err := gdb.DB(); err == nil {
		_ = sqlDB.Close()
	}
	slog.Info("bye")
	return nil
}
