package handler

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"triphub/internal/ai"
	"triphub/internal/amap"
	"triphub/internal/tianditu"
)

// Timeouts of the live checks of GET /admin/diagnostics.
var (
	diagMapTimeout = 10 * time.Second
	diagAITimeout  = 30 * time.Second
)

type amapDiag struct {
	Configured bool   `json:"configured"`
	OK         bool   `json:"ok"`
	Message    string `json:"message"`
	Infocode   string `json:"infocode,omitempty"`
	LatencyMS  int64  `json:"latency_ms"`
}

type aiDiag struct {
	Configured bool   `json:"configured"`
	OK         bool   `json:"ok"`
	Model      string `json:"model"`
	BaseURL    string `json:"base_url"`
	Thinking   string `json:"thinking"`
	TimeoutS   int    `json:"timeout_s"`
	LatencyMS  int64  `json:"latency_ms"`
	Message    string `json:"message"`
}

type tiandituDiag struct {
	Configured bool   `json:"configured"`
	OK         bool   `json:"ok"`
	Message    string `json:"message"`
	LatencyMS  int64  `json:"latency_ms"`
}

func okMessage(d time.Duration) string {
	return fmt.Sprintf("正常（用时 %d 毫秒）", d.Milliseconds())
}

// adminDiagnostics checks the configured external services live, so the
// operator can verify keys from the admin console. Keys are never included.
func (h *Handler) adminDiagnostics(c *gin.Context) error {
	ctx := c.Request.Context()
	var wg sync.WaitGroup
	var am amapDiag
	var ad aiDiag
	var td tiandituDiag

	am.Configured = h.svc.Amap.Enabled()
	if !am.Configured {
		am.Message = "未配置高德 Key（AMAP_KEY）：地点搜索只能找到省市名称，可配置天地图作为免费替代"
	} else {
		wg.Add(1)
		go func() {
			defer wg.Done()
			cctx, cancel := context.WithTimeout(ctx, diagMapTimeout)
			defer cancel()
			start := time.Now()
			err := h.svc.Amap.Check(cctx)
			am.LatencyMS = time.Since(start).Milliseconds()
			if err == nil {
				am.OK, am.Message = true, okMessage(time.Since(start))
				return
			}
			am.Infocode = amap.ErrorCode(err)
			if am.Message = amap.ErrorMessage(err); am.Message == "" {
				am.Message = "检查失败：" + err.Error()
			}
		}()
	}

	cli := h.svc.AI
	ad = aiDiag{Configured: cli.Enabled(), Model: cli.Model(), BaseURL: cli.BaseURL(), Thinking: cli.Thinking(),
		TimeoutS: int(h.cfg.AITimeout.Seconds())}
	if !ad.Configured {
		ad.Message = "未配置 AI（AI_BASE_URL 和 AI_MODEL）"
	} else {
		wg.Add(1)
		go func() {
			defer wg.Done()
			cctx, cancel := context.WithTimeout(ctx, diagAITimeout)
			defer cancel()
			start := time.Now()
			reply, err := cli.Ping(cctx)
			ad.LatencyMS = time.Since(start).Milliseconds()
			if err != nil {
				ad.Message = ai.UserMessage(err)
				return
			}
			reply = strings.TrimSpace(reply)
			if r := []rune(reply); len(r) > 20 {
				reply = string(r[:20]) + "…"
			}
			ad.OK = true
			ad.Message = fmt.Sprintf("正常：模型回复「%s」（用时 %d 毫秒）", reply, ad.LatencyMS)
		}()
	}

	td.Configured = h.svc.Tianditu.Enabled()
	if !td.Configured {
		td.Message = "未配置天地图 Key（TIANDITU_KEY，可选）"
	} else {
		wg.Add(1)
		go func() {
			defer wg.Done()
			cctx, cancel := context.WithTimeout(ctx, diagMapTimeout)
			defer cancel()
			start := time.Now()
			err := h.svc.Tianditu.Check(cctx)
			td.LatencyMS = time.Since(start).Milliseconds()
			if err == nil {
				td.OK, td.Message = true, okMessage(time.Since(start))
				return
			}
			if td.Message = tianditu.ErrorMessage(err); td.Message == "" {
				td.Message = "检查失败：" + err.Error()
			}
		}()
	}
	wg.Wait()
	c.JSON(http.StatusOK, gin.H{"amap": am, "ai": ad, "tianditu": td})
	return nil
}
