package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"triphub/internal/ai"
	"triphub/internal/service"
)

// planRequest validates a POST /ai/plan (or /ai/plan/stream) body and takes
// one call from the user's AI quota.
func (h *Handler) planRequest(c *gin.Context) (service.PlanRequest, error) {
	if !h.svc.AI.Enabled() {
		return service.PlanRequest{}, errBad("未配置 AI 服务")
	}
	var req struct {
		Destination string `json:"destination"`
		Days        int    `json:"days"`
		Preferences string `json:"preferences"`
		StartDate   string `json:"start_date"`
	}
	if err := bindJSON(c, &req); err != nil {
		return service.PlanRequest{}, err
	}
	dest, err := clean(req.Destination, "目的地", 30, true)
	if err != nil {
		return service.PlanRequest{}, err
	}
	if req.Days == 0 {
		req.Days = 3
	}
	if req.Days < 1 || req.Days > 15 {
		return service.PlanRequest{}, errBad("天数范围为 1–15 天")
	}
	prefs, err := clean(req.Preferences, "偏好", 300, false)
	if err != nil {
		return service.PlanRequest{}, err
	}
	if _, err := parseDate(req.StartDate, "start_date"); err != nil {
		return service.PlanRequest{}, err
	}
	if !h.aiLimit.Allow(fmt.Sprintf("u%d", currentUserID(c))) {
		return service.PlanRequest{}, errTooMany("AI 使用过于频繁，请稍后再试")
	}
	return service.PlanRequest{Destination: dest, Days: req.Days, Preferences: prefs, StartDate: strings.TrimSpace(req.StartDate)}, nil
}

// aiPlanError logs a failed plan and returns the message for the user.
func aiPlanError(err error) string {
	var e *ai.Error
	if errors.As(err, &e) && e.Kind == ai.KindCanceled {
		return ai.UserMessage(err) // the client went away: not worth a warning
	}
	slog.Warn("ai plan failed", "err", err)
	return ai.UserMessage(err)
}

func (h *Handler) aiPlan(c *gin.Context) error {
	req, err := h.planRequest(c)
	if err != nil {
		return err
	}
	res, err := h.svc.AIPlan(c.Request.Context(), req)
	if err != nil {
		return &apiError{http.StatusInternalServerError, "internal", aiPlanError(err)}
	}
	c.JSON(http.StatusOK, res)
	return nil
}

// Server-sent events of POST /ai/plan/stream.
var (
	// ssePing is how often a comment line keeps the stream alive while the
	// model works (proxies and browsers drop silent connections).
	ssePing = 10 * time.Second
	// sseProgressGap spaces progress events (at most about 2 a second;
	// a new stage is sent at once).
	sseProgressGap = 500 * time.Millisecond
)

// sseWriter writes server-sent events, flushing each one.
type sseWriter struct{ w gin.ResponseWriter }

func (s sseWriter) event(name string, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		b = []byte(`{"message":"服务器内部错误"}`)
		name = "error"
	}
	_, _ = fmt.Fprintf(s.w, "event: %s\ndata: %s\n\n", name, b)
	s.w.Flush()
}

func (s sseWriter) comment(text string) {
	_, _ = fmt.Fprintf(s.w, ": %s\n\n", text)
	s.w.Flush()
}

// planProgressEvent is the data of an "event: progress".
type planProgressEvent struct {
	Stage   string `json:"stage"`
	Chars   int    `json:"chars"`
	Message string `json:"message"`
}

func progressEvent(p service.PlanProgress) planProgressEvent {
	var msg string
	switch p.Stage {
	case service.PlanThinking:
		msg = "AI 正在构思行程…"
		if p.Chars > 0 {
			msg = fmt.Sprintf("AI 正在深度思考（已思考 %d 字）…", p.Chars)
		}
	case service.PlanWriting:
		msg = fmt.Sprintf("AI 正在生成行程（已生成 %d 字）…", p.Chars)
	case service.PlanLocating:
		msg = fmt.Sprintf("正在用地图核对 %d 个地点的位置…", p.Items)
	}
	return planProgressEvent{Stage: p.Stage, Chars: p.Chars, Message: msg}
}

// aiPlanStream is POST /ai/plan as server-sent events: progress while the
// model thinks and writes (the provider is asked to stream), a ": ping"
// comment every 10 s, then one "result" event with the body of POST
// /ai/plan, or an "error" event. Errors found before the stream starts
// (validation, rate limit) are ordinary JSON errors.
func (h *Handler) aiPlanStream(c *gin.Context) error {
	req, err := h.planRequest(c)
	if err != nil {
		return err
	}
	ctx := c.Request.Context()
	hd := c.Writer.Header()
	hd.Set("Content-Type", "text/event-stream; charset=utf-8")
	hd.Set("Cache-Control", "no-cache")
	hd.Set("X-Accel-Buffering", "no") // nginx: do not buffer the stream
	c.Status(http.StatusOK)
	sse := sseWriter{c.Writer}
	sse.event("progress", progressEvent(service.PlanProgress{Stage: service.PlanThinking}))

	type outcome struct {
		res *service.PlanResult
		err error
	}
	progress := make(chan service.PlanProgress, 64)
	done := make(chan outcome, 1)
	go func() {
		res, err := h.svc.AIPlanStream(ctx, req, func(p service.PlanProgress) {
			select {
			case progress <- p:
			default: // never hold up the model stream; a later report follows
			}
		})
		done <- outcome{res, err}
	}()
	ping := time.NewTicker(ssePing)
	defer ping.Stop()
	gap := time.NewTicker(sseProgressGap)
	defer gap.Stop()
	stage := service.PlanThinking
	var pending *service.PlanProgress
	for {
		select {
		case p := <-progress:
			if p.Stage != stage {
				stage, pending = p.Stage, nil
				sse.event("progress", progressEvent(p))
			} else {
				pending = &p
			}
		case <-gap.C:
			if pending != nil {
				sse.event("progress", progressEvent(*pending))
				pending = nil
			}
		case <-ping.C:
			sse.comment("ping")
		case out := <-done:
			if out.err != nil {
				sse.event("error", gin.H{"message": aiPlanError(out.err)})
			} else {
				sse.event("result", out.res)
			}
			return nil
		}
	}
}

// aiPreferences suggests sentences for the 偏好和要求 of an AI plan:
// POST /ai/preferences {destination, days?, start_date?, together?, draft?}
// → {suggestions: [string], text: string}. It takes one call from the
// user's AI quota, like /ai/plan.
func (h *Handler) aiPreferences(c *gin.Context) error {
	if !h.svc.AI.Enabled() {
		return errBad("未配置 AI 服务")
	}
	var req struct {
		Destination string `json:"destination"`
		Days        int    `json:"days"`
		StartDate   string `json:"start_date"`
		Together    bool   `json:"together"`
		Draft       string `json:"draft"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	dest, err := clean(req.Destination, "目的地", 30, true)
	if err != nil {
		return err
	}
	if req.Days < 0 || req.Days > 15 {
		return errBad("天数范围为 1–15 天")
	}
	draft, err := clean(req.Draft, "偏好", 300, false)
	if err != nil {
		return err
	}
	if _, err := parseDate(req.StartDate, "start_date"); err != nil {
		return err
	}
	if !h.aiLimit.Allow(fmt.Sprintf("u%d", currentUserID(c))) {
		return errTooMany("AI 使用过于频繁，请稍后再试")
	}
	res, err := h.svc.AIPreferences(c.Request.Context(), service.PreferencesRequest{Destination: dest, Days: req.Days,
		StartDate: strings.TrimSpace(req.StartDate), Together: req.Together, Draft: draft})
	if err != nil {
		msg := "AI 没有给出建议，请重试"
		if !errors.Is(err, service.ErrNoSuggestions) {
			msg = aiPlanError(err)
		}
		return &apiError{http.StatusInternalServerError, "internal", msg}
	}
	c.JSON(http.StatusOK, res)
	return nil
}
