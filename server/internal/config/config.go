// Package config loads TripHub configuration from environment variables.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"triphub/internal/netdiag"
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

	// TrustedProxies are the peers (IPs / CIDRs) whose X-Forwarded-For /
	// X-Real-IP headers are honoured for the client IP; nil trusts none.
	TrustedProxies []string

	TilesNormal         []string
	TilesSatellite      []string
	TilesSatelliteLabel []string
	// TilesAttribution is the basemap copyright / 审图号 shown in the corner
	// of the map (HTML allowed); set it when using other tiles.
	TilesAttribution string

	AIBaseURL string
	AIAPIKey  string
	AIModel   string
	AITimeout time.Duration
	// AIThinking is the reasoning ("deep thinking") mode: off (default), on,
	// low, high or max; see ai.Config.
	AIThinking string
	// AIExtraBody is merged into every chat completion request body
	// (TRIPHUB_AI_EXTRA_BODY, a JSON object), for provider-specific options.
	AIExtraBody map[string]any

	// TiandituKey is the optional 天地图 服务端 key (free fallback for
	// place search and reverse geocoding).
	TiandituKey string

	// Cleaned lists the key / URL / model variables whose value had to be
	// cleaned up (quotes, invisible characters, an inline comment…).
	Cleaned []Cleaned
}

// Cleaned records a variable whose value was cleaned up on load.
type Cleaned struct {
	Var     string   // e.g. TRIPHUB_AMAP_KEY
	Removed []string // what was removed, in Chinese
}

// invisibleChars are removed from keys, URLs and model names: a BOM and
// zero-width characters that come with text copied from web pages and chats.
var invisibleChars = strings.NewReplacer("\ufeff", "", "\u200b", "", "\u200c", "", "\u200d", "", "\u2060", "")

// quotePairs are the quotes stripped from around a value.
var quotePairs = map[rune]rune{'"': '"', '\'': '\'', '“': '”', '‘': '’'}

// cleanValue cleans up a key, URL or model name read from the environment:
// it removes a BOM and zero-width characters, CR / LF and surrounding
// whitespace, one pair of surrounding matching quotes and a trailing
// comment introduced by whitespace and '#' (as .env files allow). removed
// says what was taken away.
func cleanValue(raw string) (v string, removed []string) {
	v = raw
	if t := invisibleChars.Replace(v); t != v {
		v, removed = t, append(removed, "BOM / 零宽字符")
	}
	if t := strings.NewReplacer("\r", "", "\n", "").Replace(v); t != v {
		v, removed = t, append(removed, "换行符")
	}
	if t := strings.TrimSpace(v); t != v {
		v, removed = t, append(removed, "首尾空白")
	}
	if q, size := utf8.DecodeRuneInString(v); quotePairs[q] != 0 {
		if end := strings.IndexRune(v[size:], quotePairs[q]); end >= 0 {
			inner, rest := v[size:size+end], strings.TrimSpace(v[size+end+utf8.RuneLen(quotePairs[q]):])
			if rest == "" || strings.HasPrefix(rest, "#") {
				removed = append(removed, "首尾引号")
				if rest != "" {
					removed = append(removed, "行尾注释")
				}
				if t := strings.TrimSpace(inner); t != inner {
					removed = append(removed, "引号内的首尾空白")
					inner = t
				}
				return inner, removed
			}
		}
	}
	for i, r := range v {
		if r != '#' || i == 0 {
			continue
		}
		if prev, _ := utf8.DecodeLastRuneInString(v[:i]); unicode.IsSpace(prev) {
			v, removed = strings.TrimSpace(v[:i]), append(removed, "行尾注释")
			break
		}
	}
	return v, removed
}

// clean reads and cleans up the variable name, recording what was removed.
func (c *Config) clean(name string) string {
	v, removed := cleanValue(os.Getenv(name))
	if len(removed) > 0 {
		c.Cleaned = append(c.Cleaned, Cleaned{Var: name, Removed: removed})
	}
	return v
}

// KeyInfo is a fingerprint of a configured key.
type KeyInfo struct {
	Var  string // e.g. TRIPHUB_AMAP_KEY
	Hint netdiag.KeyHint
}

// KeyHints describes the configured keys without revealing them (unset
// keys are left out).
func (c *Config) KeyHints() []KeyInfo {
	aiFormat := netdiag.AnyKey
	if strings.Contains(strings.ToLower(c.AIBaseURL), "deepseek") {
		aiFormat = netdiag.DeepSeekKey
	}
	var out []KeyInfo
	for _, k := range []struct {
		name, v string
		f       netdiag.KeyFormat
	}{
		{"TRIPHUB_AMAP_KEY", c.AmapKey, netdiag.HexKey},
		{"TRIPHUB_AI_API_KEY", c.AIAPIKey, aiFormat},
		{"TRIPHUB_TIANDITU_KEY", c.TiandituKey, netdiag.HexKey},
	} {
		if k.v != "" {
			out = append(out, KeyInfo{Var: k.name, Hint: netdiag.Fingerprint(k.v, k.f)})
		}
	}
	return out
}

// LogKeys logs a fingerprint of each configured key (never the key) and a
// warning for each value that had to be cleaned up.
func (c *Config) LogKeys() {
	for _, k := range c.KeyHints() {
		args := []any{"var", k.Var, "key", k.Hint.Text}
		if k.Hint.Warning != "" {
			args = append(args, "warning", k.Hint.Warning)
		}
		slog.Info("key configured", args...)
	}
	for _, cl := range c.Cleaned {
		slog.Warn("配置值含有多余字符，已自动去掉；请修正 .env 中对应的一行", "var", cl.Var,
			"removed", strings.Join(cl.Removed, "、"))
	}
}

// DefaultAITimeout is the default TRIPHUB_AI_TIMEOUT: a multi-day plan from
// a cloud model takes 20–60 s, longer with reasoning.
const DefaultAITimeout = 120 * time.Second

// aiThinkingModes are the accepted TRIPHUB_AI_THINKING values (and aliases).
var aiThinkingModes = map[string]string{
	"": "off", "off": "off", "false": "off", "0": "off", "no": "off", "disabled": "off", "disable": "off", "none": "off",
	"on": "on", "true": "on", "1": "on", "yes": "on", "enabled": "on", "enable": "on",
	"low": "low", "medium": "high", "high": "high", "max": "max",
}

// defaultTrustedProxies are loopback and private networks: a reverse proxy
// on the host or in the compose network (Caddy, Nginx / 宝塔).
var defaultTrustedProxies = []string{"127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "::1/128", "fc00::/7"}

// trustedProxies parses TRIPHUB_TRUSTED_PROXIES: empty = the defaults,
// "none" = trust nobody, otherwise comma-separated IPs / CIDRs.
func trustedProxies(v string) ([]string, error) {
	v = strings.TrimSpace(v)
	switch {
	case v == "":
		return append([]string{}, defaultTrustedProxies...), nil
	case strings.EqualFold(v, "none"):
		return []string{}, nil
	}
	out := list(v)
	for _, s := range out {
		if _, _, err := net.ParseCIDR(s); err != nil && net.ParseIP(s) == nil {
			return nil, fmt.Errorf("invalid TRIPHUB_TRUSTED_PROXIES entry %q", s)
		}
	}
	return out, nil
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
		JWTSecret:     strings.TrimSpace(os.Getenv("TRIPHUB_JWT_SECRET")),
		AdminUsername: strings.TrimSpace(os.Getenv("TRIPHUB_ADMIN_USERNAME")),
		AdminPassword: os.Getenv("TRIPHUB_ADMIN_PASSWORD"),
		CORSOrigins:   list(os.Getenv("TRIPHUB_CORS_ORIGINS")),
		MaxUploadMB:   20,
		SiteName:      env("TRIPHUB_SITE_NAME", "TripHub"),

		TilesNormal:         list(os.Getenv("TRIPHUB_TILES_NORMAL")),
		TilesSatellite:      list(os.Getenv("TRIPHUB_TILES_SATELLITE")),
		TilesSatelliteLabel: list(os.Getenv("TRIPHUB_TILES_SATELLITE_LABEL")),
		TilesAttribution:    env("TRIPHUB_TILES_ATTRIBUTION", "© 高德地图"),

		AITimeout: DefaultAITimeout,
	}
	// Keys, the AI endpoint and model are cleaned up: values pasted into .env
	// often carry quotes, invisible characters or a comment.
	c.AmapKey = c.clean("TRIPHUB_AMAP_KEY")
	c.AIBaseURL = strings.TrimRight(c.clean("TRIPHUB_AI_BASE_URL"), "/")
	c.AIAPIKey = c.clean("TRIPHUB_AI_API_KEY")
	c.AIModel = c.clean("TRIPHUB_AI_MODEL")
	c.TiandituKey = c.clean("TRIPHUB_TIANDITU_KEY")
	mode, ok := aiThinkingModes[strings.ToLower(strings.TrimSpace(os.Getenv("TRIPHUB_AI_THINKING")))]
	if !ok {
		return nil, fmt.Errorf("invalid TRIPHUB_AI_THINKING %q (off / on / low / high / max)", os.Getenv("TRIPHUB_AI_THINKING"))
	}
	c.AIThinking = mode
	if v := strings.TrimSpace(os.Getenv("TRIPHUB_AI_EXTRA_BODY")); v != "" {
		var extra map[string]any
		if err := json.Unmarshal([]byte(v), &extra); err != nil || extra == nil {
			return nil, fmt.Errorf("invalid TRIPHUB_AI_EXTRA_BODY: must be a JSON object such as {\"enable_thinking\": false}")
		}
		c.AIExtraBody = extra
	}
	tp, err := trustedProxies(os.Getenv("TRIPHUB_TRUSTED_PROXIES"))
	if err != nil {
		return nil, err
	}
	c.TrustedProxies = tp
	if v := strings.TrimSpace(os.Getenv("TRIPHUB_MAX_UPLOAD_MB")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 || n > 1024 {
			return nil, fmt.Errorf("invalid TRIPHUB_MAX_UPLOAD_MB %q", v)
		}
		c.MaxUploadMB = n
	}
	if v := strings.TrimSpace(os.Getenv("TRIPHUB_AI_TIMEOUT")); v != "" {
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

// minJWTSecretLen is the minimum JWT secret length: HS256 needs a key of at
// least 256 bits (RFC 7518 §3.2); a short secret can be brute-forced offline
// from any issued token and then used to forge admin tokens.
const minJWTSecretLen = 32

// Prepare creates the data directories and loads or generates the JWT secret
// (persisted at DATA_DIR/jwt_secret when not given via environment).
func (c *Config) Prepare() error {
	if err := os.MkdirAll(c.UploadDir(), 0o755); err != nil {
		return fmt.Errorf("create data dir: %w", err)
	}
	if c.JWTSecret != "" {
		if len(c.JWTSecret) < minJWTSecretLen {
			return fmt.Errorf("TRIPHUB_JWT_SECRET 过短（%d 个字符），至少需要 %d 个字符；留空会自动生成，或用 openssl rand -hex 32 生成",
				len(c.JWTSecret), minJWTSecretLen)
		}
		return nil
	}
	path := filepath.Join(c.DataDir, "jwt_secret")
	b, err := os.ReadFile(path)
	if err == nil && len(strings.TrimSpace(string(b))) >= minJWTSecretLen {
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
