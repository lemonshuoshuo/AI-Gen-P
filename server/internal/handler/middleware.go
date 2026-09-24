package handler

import (
	"log/slog"
	"net/http"
	"runtime/debug"
	"slices"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"triphub/internal/model"
)

const (
	ctxUser    = "triphub.user"
	ctxBanned  = "triphub.banned"
	ctxSession = "triphub.session"
)

func recovery() gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			if r := recover(); r != nil {
				if r == http.ErrAbortHandler {
					panic(r)
				}
				slog.Error("panic", "path", c.Request.URL.Path, "panic", r, "stack", string(debug.Stack()))
				abortJSON(c, http.StatusInternalServerError, "internal", "服务器内部错误，请稍后重试")
			}
		}()
		c.Next()
	}
}

func requestLogger() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		status := c.Writer.Status()
		path := c.Request.URL.Path
		// Keep logs readable: skip successful static asset requests.
		if status < 400 && !strings.HasPrefix(path, "/api/") {
			return
		}
		lvl := slog.LevelInfo
		if status >= 500 {
			lvl = slog.LevelError
		} else if status >= 400 {
			lvl = slog.LevelWarn
		}
		slog.Log(c.Request.Context(), lvl, "http", "method", c.Request.Method, "path", path, "status", status,
			"ms", time.Since(start).Milliseconds(), "ip", c.ClientIP())
	}
}

func (h *Handler) cors() gin.HandlerFunc {
	origins := h.cfg.CORSOrigins
	anyOrigin := slices.Contains(origins, "*")
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin != "" && (anyOrigin || slices.Contains(origins, origin)) {
			hd := c.Writer.Header()
			hd.Set("Access-Control-Allow-Origin", origin)
			hd.Add("Vary", "Origin")
			hd.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			hd.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Share-Code")
			hd.Set("Access-Control-Max-Age", "86400")
			if c.Request.Method == http.MethodOptions {
				c.AbortWithStatus(http.StatusNoContent)
				return
			}
		}
		c.Next()
	}
}

// bodyLimit caps request bodies: uploads get the configured limit, JSON 4 MB.
func (h *Handler) bodyLimit() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.Body != nil {
			limit := int64(4 << 20)
			if strings.HasPrefix(c.GetHeader("Content-Type"), "multipart/") {
				limit = h.cfg.MaxUploadBytes() + 1<<20
			}
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
		}
		c.Next()
	}
}

// authenticate resolves the bearer token. A present but invalid/expired
// token yields 401 so clients refresh; banned users are treated as guests
// on public endpoints and rejected by requireUser.
func (h *Handler) authenticate() gin.HandlerFunc {
	return func(c *gin.Context) {
		hdr := c.GetHeader("Authorization")
		if hdr == "" {
			c.Next()
			return
		}
		token, ok := strings.CutPrefix(hdr, "Bearer ")
		if !ok {
			token, ok = strings.CutPrefix(hdr, "bearer ")
		}
		token = strings.TrimSpace(token)
		if !ok || token == "" {
			c.Next()
			return
		}
		// Refresh/logout/login must work even with a stale access token.
		p := c.Request.URL.Path
		if strings.HasPrefix(p, "/api/v1/auth/") {
			c.Next()
			return
		}
		uid, sid, err := h.tokens.ParseAccess(token)
		if err != nil {
			abortJSON(c, http.StatusUnauthorized, "unauthorized", "登录已过期，请重新登录")
			return
		}
		var u model.User
		if err := h.db.WithContext(c.Request.Context()).Limit(1).Find(&u, uid).Error; err != nil {
			writeError(c, err)
			return
		}
		if u.ID == 0 {
			abortJSON(c, http.StatusUnauthorized, "unauthorized", "账号不存在，请重新登录")
			return
		}
		if u.Status == model.UserBanned {
			c.Set(ctxBanned, true)
			c.Next()
			return
		}
		c.Set(ctxUser, &u)
		c.Set(ctxSession, sid)
		c.Next()
	}
}

func (h *Handler) requireUser() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.GetBool(ctxBanned) {
			abortJSON(c, http.StatusForbidden, "forbidden", "账号已被封禁")
			return
		}
		if currentUser(c) == nil {
			abortJSON(c, http.StatusUnauthorized, "unauthorized", "请先登录")
			return
		}
		c.Next()
	}
}

func (h *Handler) requireAdmin() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !currentUser(c).IsAdmin() {
			abortJSON(c, http.StatusForbidden, "forbidden", "需要管理员权限")
			return
		}
		c.Next()
	}
}

// currentUser returns the authenticated user or nil for guests.
func currentUser(c *gin.Context) *model.User {
	if v, ok := c.Get(ctxUser); ok {
		return v.(*model.User)
	}
	return nil
}

func currentUserID(c *gin.Context) int64 {
	if u := currentUser(c); u != nil {
		return u.ID
	}
	return 0
}
