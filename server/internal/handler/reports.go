package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"triphub/internal/model"
)

func (h *Handler) createReport(c *gin.Context) error {
	var req struct {
		TargetType string `json:"target_type"`
		TargetID   int64  `json:"target_id"`
		Reason     string `json:"reason"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	reason, err := clean(req.Reason, "举报理由", 500, true)
	if err != nil {
		return err
	}
	db := h.db.WithContext(c.Request.Context())
	var target any
	switch req.TargetType {
	case "trip":
		target = &model.Trip{}
	case "comment":
		target = &model.Comment{}
	case "user":
		target = &model.User{}
	case "place":
		target = &model.Place{}
	default:
		return errBad("target_type 只能是 trip / comment / user / place")
	}
	var n int64
	if err := db.Model(target).Where("id = ?", req.TargetID).Count(&n).Error; err != nil {
		return err
	}
	if n == 0 {
		return errNotFound("举报对象不存在")
	}
	uid := currentUserID(c)
	// Collapse repeated pending reports of the same target by the same user.
	var existing model.Report
	if err := db.Where("reporter_id = ? AND target_type = ? AND target_id = ? AND status = ?", uid, req.TargetType, req.TargetID, model.ReportPending).
		Limit(1).Find(&existing).Error; err != nil {
		return err
	}
	if existing.ID != 0 {
		c.JSON(http.StatusOK, gin.H{"id": existing.ID})
		return nil
	}
	r := model.Report{ReporterID: uid, TargetType: req.TargetType, TargetID: req.TargetID, Reason: reason, Status: model.ReportPending}
	if err := db.Create(&r).Error; err != nil {
		return err
	}
	c.JSON(http.StatusOK, gin.H{"id": r.ID})
	return nil
}
