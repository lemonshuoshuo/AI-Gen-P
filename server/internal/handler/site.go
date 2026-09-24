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
		"icp_beian":         st.ICPBeian,
		"police_beian":      st.PoliceBeian,
		"amap_search":       h.svc.Amap.Enabled(),
		"ai_enabled":        h.svc.AI.Enabled(),
		"map": gin.H{
			"attribution": h.cfg.TilesAttribution,
			"tiles": gin.H{
				"normal":          h.cfg.TilesNormal,
				"satellite":       h.cfg.TilesSatellite,
				"satellite_label": h.cfg.TilesSatelliteLabel,
			},
		},
		"levels":        service.Levels,
		"exp_daily_cap": service.DailyExpCap,
		"upload":        gin.H{"max_photo_mb": h.cfg.MaxUploadMB},
	})
	return nil
}

// legal serves the 用户协议 (terms) or 隐私政策 (privacy) as Markdown. The
// texts are long, so they are not part of GET /site.
func (h *Handler) legal(c *gin.Context) error {
	text, ok := h.svc.Settings.Get().LegalText(c.Param("doc"))
	if !ok {
		return errNotFound("页面不存在")
	}
	c.JSON(http.StatusOK, gin.H{"content": text})
	return nil
}
