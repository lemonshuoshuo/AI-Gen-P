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
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	_ "golang.org/x/crypto/x509roots/fallback" // CA roots for scratch images
	_ "time/tzdata"                            // embedded zoneinfo for scratch images

	"triphub/internal/ai"
	"triphub/internal/amap"
	"triphub/internal/auth"
	"triphub/internal/config"
	"triphub/internal/db"
	"triphub/internal/geo"
	"triphub/internal/handler"
	"triphub/internal/media"
	"triphub/internal/model"
	"triphub/internal/service"
	"triphub/internal/version"
	"triphub/internal/webui"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "reset-password" {
		if err := resetPasswordCmd(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "错误：", err)
			os.Exit(1)
		}
		return
	}
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
	switch res, err := svc.SeedAdmin(ctx, cfg.AdminUsername, cfg.AdminPassword); {
	case err != nil:
		return fmt.Errorf("seed admin: %w", err)
	case res == service.SeedCreated:
		slog.Info("admin account created", "username", cfg.AdminUsername)
	case res == service.SeedPromoted:
		slog.Info("existing user promoted to admin", "username", cfg.AdminUsername)
	case res == service.SeedExists:
		slog.Warn("管理员账号已存在，TRIPHUB_ADMIN_PASSWORD 不会覆盖其密码；忘记密码请运行 triphub reset-password", "username", cfg.AdminUsername)
	case res == service.SeedConflict:
		slog.Warn("TRIPHUB_ADMIN_USERNAME 已被普通用户注册且密码不匹配，未授予管理员权限", "username", cfg.AdminUsername)
	}
	// Corrects place statistics stored by versions that counted them differently (runs once).
	if err := svc.BackfillPlaceStats(ctx); err != nil {
		slog.Warn("recompute place statistics", "err", err)
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

// resetPasswordCmd implements `triphub reset-password`: sets a new password
// for an account from the server shell, e.g. a forgotten admin password
// (docker compose exec app /triphub reset-password -user admin).
func resetPasswordCmd(args []string) error {
	flags := flag.NewFlagSet("reset-password", flag.ContinueOnError)
	user := flags.String("user", "", "用户名（必填）")
	password := flags.String("password", "", "新密码（8–64 位；留空则随机生成）")
	admin := flags.Bool("admin", false, "同时设为管理员并解除封禁")
	flags.Usage = func() {
		fmt.Fprintln(flags.Output(), "用法：triphub reset-password -user <用户名> [-password <新密码>] [-admin]")
		flags.PrintDefaults()
	}
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	name := strings.TrimSpace(*user)
	if name == "" {
		flags.Usage()
		return errors.New("请用 -user 指定用户名")
	}
	pw := *password
	if pw == "" {
		pw = auth.RandomBase62(12)
	} else if err := auth.ValidatePassword(pw); err != nil {
		return err
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	gdb, err := db.Open(ctx, cfg.DBDSN, 30*time.Second)
	if err != nil {
		return err
	}
	if sqlDB, err := gdb.DB(); err == nil {
		defer sqlDB.Close()
	}
	var u model.User
	if err := gdb.WithContext(ctx).Where("lower(username) = lower(?)", name).Limit(1).Find(&u).Error; err != nil {
		return err
	}
	if u.ID == 0 {
		return fmt.Errorf("用户 %q 不存在", name)
	}
	if u.Status == model.UserDeleted {
		return fmt.Errorf("用户 %q 已注销", name)
	}
	if err := service.ResetPassword(ctx, gdb, u.ID, pw); err != nil {
		return err
	}
	if *admin {
		if err := gdb.WithContext(ctx).Model(&u).Updates(map[string]any{"role": model.RoleAdmin, "status": model.UserActive}).Error; err != nil {
			return err
		}
	}
	fmt.Printf("已重置 %s 的密码：%s\n", u.Username, pw)
	if *admin {
		fmt.Println("该账号已设为管理员")
	}
	fmt.Println("该用户所有设备上的登录已失效，请登录后在「设置」中修改密码。")
	return nil
}
