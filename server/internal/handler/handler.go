// Package handler implements the TripHub HTTP API (see docs/API.md).
package handler

import (
	"io/fs"
	"log/slog"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"triphub/internal/auth"
	"triphub/internal/config"
	"triphub/internal/service"
)

// Handler holds dependencies for HTTP handlers.
type Handler struct {
	svc    *service.Service
	db     *gorm.DB
	cfg    *config.Config
	tokens *auth.Tokens
	loc    *time.Location

	loginAccount *auth.Limiter // failed logins per IP+account
	loginIP      *auth.Limiter // failed logins per IP
	register     *auth.Limiter // registrations per IP
	aiLimit      *auth.Limiter // AI calls per user
	commentLimit *auth.Limiter // comments per user
	geoLimit     *auth.Limiter // geo search / regeo per user
	views        *auth.Limiter // view-count de-duplication

	trackCache *trackCache // rendered GET /trips/:id/track payloads

	webui fs.FS

	atlasOnce sync.Once
	atlasGz   []byte
	atlasETag string

	gzAssets sync.Map // embedded asset name → gzip bytes ([]byte(nil) = serve raw)
}

// New creates a Handler. webui is the embedded SPA (may be nil).
func New(svc *service.Service, webui fs.FS) *Handler {
	return &Handler{
		svc:          svc,
		db:           svc.DB,
		cfg:          svc.Cfg,
		tokens:       auth.NewTokens(svc.Cfg.JWTSecret),
		loc:          svc.Loc,
		loginAccount: auth.NewLimiter(5, 15*time.Minute),
		loginIP:      auth.NewLimiter(30, 15*time.Minute),
		register:     auth.NewLimiter(10, time.Hour),
		aiLimit:      auth.NewLimiter(30, time.Hour),
		commentLimit: auth.NewLimiter(30, 10*time.Minute),
		geoLimit:     auth.NewLimiter(120, 10*time.Minute),
		views:        auth.NewLimiter(1, 30*time.Minute),
		trackCache:   newTrackCache(trackCacheBytes),
		webui:        webui,
	}
}

// Cleanup purges expired limiter state and refresh tokens; call periodically.
func (h *Handler) Cleanup() {
	for _, l := range []*auth.Limiter{h.loginAccount, h.loginIP, h.register, h.aiLimit, h.commentLimit, h.geoLimit, h.views} {
		l.Cleanup()
	}
	h.db.Exec("DELETE FROM refresh_tokens WHERE expires_at < now()")
}

// Router builds the gin engine with all routes.
func (h *Handler) Router() *gin.Engine {
	r := gin.New()
	r.RedirectTrailingSlash = false
	r.HandleMethodNotAllowed = false
	// Honour X-Forwarded-For / X-Real-IP only from TRIPHUB_TRUSTED_PROXIES
	// (default: loopback and private networks, i.e. reverse proxies), so
	// clients cannot spoof their IP for rate limits. Docker's userland proxy
	// (IPv6 clients of an IPv4-only network, rootless Docker, frp-style
	// tunnels) makes every client appear as a private address, which is why
	// the compose file publishes the port on IPv4 only.
	if err := r.SetTrustedProxies(h.cfg.TrustedProxies); err != nil {
		slog.Error("invalid trusted proxies", "err", err)
	}
	r.Use(recovery(), requestLogger(), h.cors())

	// gzip after bodyLimit (MaxBytesReader keeps the raw writer) and before
	// authenticate (so its 401 JSON is compressed too).
	api := r.Group("/api/v1", h.bodyLimit(), gzipAPI(), h.authenticate())
	user := h.requireUser()
	admin := h.requireAdmin()

	api.GET("/health", w(h.health))
	api.GET("/site", w(h.site))
	api.GET("/site/legal/:doc", w(h.legal))

	api.POST("/auth/register", w(h.registerUser))
	api.POST("/auth/login", w(h.login))
	api.POST("/auth/refresh", w(h.refresh))
	api.POST("/auth/logout", w(h.logout))

	api.GET("/me", user, w(h.getMe))
	api.PATCH("/me", user, w(h.updateMe))
	api.DELETE("/me", user, w(h.deleteMe))
	api.POST("/me/password", user, w(h.changePassword))
	api.POST("/me/avatar", user, w(h.uploadAvatar))
	api.GET("/me/trips", user, w(h.myTrips))
	api.GET("/me/favorites", user, w(h.myFavorites))
	api.GET("/me/footprints", user, w(h.myFootprints))
	api.GET("/me/invites", user, w(h.myInvites))

	api.GET("/users/:username", w(h.userProfile))
	api.GET("/users/:username/trips", w(h.userTrips))
	api.GET("/users/:username/footprints", w(h.userFootprints))
	api.POST("/users/:username/follow", user, w(h.follow))
	api.DELETE("/users/:username/follow", user, w(h.unfollow))
	api.GET("/users/:username/followers", w(h.followers))
	api.GET("/users/:username/following", w(h.following))

	api.GET("/trips", w(h.listTrips))
	api.POST("/trips", user, w(h.createTrip))
	api.GET("/trips/:id", w(h.getTrip))
	api.GET("/share/:code", w(h.getShared))
	api.PATCH("/trips/:id", user, w(h.updateTrip))
	api.DELETE("/trips/:id", user, w(h.deleteTrip))
	api.POST("/trips/:id/fork", user, w(h.forkTrip))
	api.POST("/trips/:id/like", user, w(h.like))
	api.DELETE("/trips/:id/like", user, w(h.unlike))
	api.POST("/trips/:id/favorite", user, w(h.favorite))
	api.DELETE("/trips/:id/favorite", user, w(h.unfavorite))
	api.POST("/trips/:id/share-code/reset", user, w(h.resetShareCode))

	api.GET("/trips/:id/members", user, w(h.listMembers))
	api.POST("/trips/:id/members", user, w(h.inviteMember))
	api.DELETE("/trips/:id/members/:user_id", user, w(h.removeMember))
	api.POST("/trips/:id/members/accept", user, w(h.acceptInvite))
	api.POST("/trips/:id/members/decline", user, w(h.declineInvite))

	api.POST("/trips/:id/waypoints", user, w(h.createWaypoint))
	api.POST("/trips/:id/waypoints/batch", user, w(h.batchWaypoints))
	api.PUT("/trips/:id/waypoints/order", user, w(h.orderWaypoints))
	api.PATCH("/waypoints/:id", user, w(h.updateWaypoint))
	api.DELETE("/waypoints/:id", user, w(h.deleteWaypoint))

	api.POST("/trips/:id/checkin", user, w(h.tripCheckin))
	api.POST("/waypoints/:id/checkin", user, w(h.waypointCheckin))
	api.POST("/waypoints/:id/skip", user, w(h.waypointSkip))
	api.POST("/waypoints/:id/reset", user, w(h.waypointReset))
	api.GET("/trips/:id/recommend", user, w(h.recommend))
	api.GET("/trips/:id/compare", w(h.compare))
	// Legs spend the operator's AMap quota: users only.
	api.GET("/trips/:id/legs", user, w(h.legs))
	api.POST("/ai/plan", user, w(h.aiPlan))

	api.POST("/trips/:id/photos", user, w(h.uploadPhoto))
	api.PATCH("/photos/:id", user, w(h.updatePhoto))
	api.DELETE("/photos/:id", user, w(h.deletePhoto))
	api.POST("/uploads/image", user, w(h.uploadImage))

	api.POST("/trips/:id/track", user, w(h.appendTrack))
	api.GET("/trips/:id/track", w(h.getTrack))
	api.DELETE("/trips/:id/track", user, w(h.clearTrack))
	api.POST("/trips/:id/track/import", user, w(h.importTrack))

	api.GET("/trips/:id/comments", w(h.tripComments))
	api.POST("/trips/:id/comments", user, w(h.postTripComment))
	api.GET("/places/:id/comments", w(h.placeComments))
	api.POST("/places/:id/comments", user, w(h.postPlaceComment))
	api.DELETE("/comments/:id", user, w(h.deleteComment))

	api.GET("/places", w(h.listPlaces))
	api.GET("/places/nearby", w(h.nearbyPlaces))
	api.GET("/places/:id", w(h.getPlace))
	api.GET("/places/:id/reviews", w(h.placeReviews))

	// Search / regeo spend the operator's AMap quota: users only, rate-limited.
	api.GET("/geo/search", user, w(h.geoSearch))
	api.GET("/geo/regeo", user, w(h.geoRegeo))
	api.GET("/geo/atlas", h.geoAtlas)

	api.GET("/partner", user, w(h.getPartner))
	api.PATCH("/partner", user, w(h.updatePartner))
	api.DELETE("/partner", user, w(h.unbindPartner))
	api.POST("/partner/invites", user, w(h.createPartnerInvite))
	api.POST("/partner/invites/:id/accept", user, w(h.acceptPartnerInvite))
	api.POST("/partner/invites/:id/decline", user, w(h.declinePartnerInvite))
	api.DELETE("/partner/invites/:id", user, w(h.cancelPartnerInvite))
	api.GET("/partner/trips", user, w(h.partnerTrips))
	api.GET("/partner/footprints", user, w(h.partnerFootprints))

	api.GET("/notifications", user, w(h.listNotifications))
	api.GET("/notifications/unread-count", user, w(h.unreadCount))
	api.POST("/notifications/read", user, w(h.markRead))

	api.POST("/reports", user, w(h.createReport))

	adm := api.Group("/admin", user, admin)
	adm.GET("/stats", w(h.adminStats))
	adm.GET("/users", w(h.adminUsers))
	adm.PATCH("/users/:id", w(h.adminUpdateUser))
	adm.POST("/users/:id/reset-password", w(h.adminResetPassword))
	adm.GET("/trips", w(h.adminTrips))
	adm.PATCH("/trips/:id", w(h.adminUpdateTrip))
	adm.DELETE("/trips/:id", w(h.adminDeleteTrip))
	adm.GET("/comments", w(h.adminComments))
	adm.DELETE("/comments/:id", w(h.adminDeleteComment))
	adm.GET("/reports", w(h.adminReports))
	adm.PATCH("/reports/:id", w(h.adminUpdateReport))
	adm.GET("/settings", w(h.adminGetSettings))
	adm.PUT("/settings", w(h.adminPutSettings))

	r.GET("/uploads/*filepath", h.serveUploads)
	r.HEAD("/uploads/*filepath", h.serveUploads)
	r.NoRoute(h.noRoute)
	return r
}
