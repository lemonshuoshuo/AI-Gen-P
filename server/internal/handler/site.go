package handler

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"triphub/internal/service"
	"triphub/internal/version"
)

func (h *Handler) health(c *gin.Context) error {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
	defer cancel()
	sqlDB, err := h.db.DB()
	if err == nil {
		err = sqlDB.PingContext(ctx)
	}
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"status": "error", "version": version.Version, "db": "unreachable"})
		return nil
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok", "version": version.Version})
	return nil
}

func (h *Handler) site(c *gin.Context) error {
	st := h.svc.Settings.Get()
	c.JSON(http.StatusOK, gin.H{
		"name":              st.SiteName,
		"announcement":      st.Announcement,
		"registration_open": st.RegistrationOpen,
		"amap_search":       h.svc.Amap.Enabled(),
		"ai_enabled":        h.svc.AI.Enabled(),
		"map": gin.H{"tiles": gin.H{
			"normal":          h.cfg.TilesNormal,
			"satellite":       h.cfg.TilesSatellite,
			"satellite_label": h.cfg.TilesSatelliteLabel,
		}},
		"levels": service.Levels,
		"upload": gin.H{"max_photo_mb": h.cfg.MaxUploadMB},
	})
	return nil
}
