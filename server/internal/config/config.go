// Package config loads TripHub configuration from environment variables.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Config is the runtime configuration.
type Config struct {
	Addr          string
	DBDSN         string
	DataDir       string
	JWTSecret     string
	AdminUsername string
	AdminPassword string
	AmapKey       string
	CORSOrigins   []string
	MaxUploadMB   int
	SiteName      string

	TilesNormal         []string
	TilesSatellite      []string
	TilesSatelliteLabel []string

	AIBaseURL string
	AIAPIKey  string
	AIModel   string
	AITimeout time.Duration
}

func defaultTiles(tpl string) []string {
	out := make([]string, 4)
	for i := range out {
		out[i] = fmt.Sprintf(tpl, i+1)
	}
	return out
}

// Load reads configuration from the environment.
func Load() (*Config, error) {
	c := &Config{
		Addr:          env("TRIPHUB_ADDR", ":8080"),
		DBDSN:         env("TRIPHUB_DB_DSN", "postgres://triphub:triphub@localhost:5432/triphub?sslmode=disable"),
		DataDir:       env("TRIPHUB_DATA_DIR", "./data"),
		JWTSecret:     os.Getenv("TRIPHUB_JWT_SECRET"),
		AdminUsername: strings.TrimSpace(os.Getenv("TRIPHUB_ADMIN_USERNAME")),
		AdminPassword: os.Getenv("TRIPHUB_ADMIN_PASSWORD"),
		AmapKey:       strings.TrimSpace(os.Getenv("TRIPHUB_AMAP_KEY")),
		CORSOrigins:   list(os.Getenv("TRIPHUB_CORS_ORIGINS")),
		MaxUploadMB:   20,
		SiteName:      env("TRIPHUB_SITE_NAME", "TripHub"),

		TilesNormal:         list(os.Getenv("TRIPHUB_TILES_NORMAL")),
		TilesSatellite:      list(os.Getenv("TRIPHUB_TILES_SATELLITE")),
		TilesSatelliteLabel: list(os.Getenv("TRIPHUB_TILES_SATELLITE_LABEL")),

		AIBaseURL: strings.TrimRight(strings.TrimSpace(os.Getenv("TRIPHUB_AI_BASE_URL")), "/"),
		AIAPIKey:  strings.TrimSpace(os.Getenv("TRIPHUB_AI_API_KEY")),
		AIModel:   strings.TrimSpace(os.Getenv("TRIPHUB_AI_MODEL")),
		AITimeout: 30 * time.Second,
	}
	if v := os.Getenv("TRIPHUB_MAX_UPLOAD_MB"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 || n > 1024 {
			return nil, fmt.Errorf("invalid TRIPHUB_MAX_UPLOAD_MB %q", v)
		}
		c.MaxUploadMB = n
	}
	if v := os.Getenv("TRIPHUB_AI_TIMEOUT"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			// Accept a bare number of seconds as well.
			n, nerr := strconv.Atoi(v)
			if nerr != nil {
				return nil, fmt.Errorf("invalid TRIPHUB_AI_TIMEOUT %q", v)
			}
			d = time.Duration(n) * time.Second
		}
		if d <= 0 {
			return nil, fmt.Errorf("invalid TRIPHUB_AI_TIMEOUT %q", v)
		}
		c.AITimeout = d
	}
	if len(c.TilesNormal) == 0 {
		c.TilesNormal = defaultTiles("https://webrd0%d.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}")
	}
	if len(c.TilesSatellite) == 0 {
		c.TilesSatellite = defaultTiles("https://webst0%d.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}")
	}
	if len(c.TilesSatelliteLabel) == 0 {
		c.TilesSatelliteLabel = defaultTiles("https://webst0%d.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}")
	}
	return c, nil
}

// UploadDir is where user files are stored.
func (c *Config) UploadDir() string { return filepath.Join(c.DataDir, "uploads") }

// MaxUploadBytes is the per-file upload limit in bytes.
func (c *Config) MaxUploadBytes() int64 { return int64(c.MaxUploadMB) << 20 }

// AIEnabled reports whether an AI model endpoint is configured.
func (c *Config) AIEnabled() bool { return c.AIBaseURL != "" && c.AIModel != "" }

// Prepare creates the data directories and loads or generates the JWT secret
// (persisted at DATA_DIR/jwt_secret when not given via environment).
func (c *Config) Prepare() error {
	if err := os.MkdirAll(c.UploadDir(), 0o755); err != nil {
		return fmt.Errorf("create data dir: %w", err)
	}
	if c.JWTSecret != "" {
		return nil
	}
	path := filepath.Join(c.DataDir, "jwt_secret")
	b, err := os.ReadFile(path)
	if err == nil && len(strings.TrimSpace(string(b))) >= 32 {
		c.JWTSecret = strings.TrimSpace(string(b))
		return nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read jwt secret: %w", err)
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return err
	}
	c.JWTSecret = hex.EncodeToString(buf)
	if err := os.WriteFile(path, []byte(c.JWTSecret+"\n"), 0o600); err != nil {
		return fmt.Errorf("write jwt secret: %w", err)
	}
	return nil
}

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func list(v string) []string {
	var out []string
	for _, s := range strings.Split(v, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}
