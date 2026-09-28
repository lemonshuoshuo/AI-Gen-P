package handler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"triphub/internal/ai"
	"triphub/internal/amap"
	"triphub/internal/netdiag"
	"triphub/internal/tianditu"
)

// Timeouts of the live checks of GET /admin/diagnostics.
var (
	diagMapTimeout = 12 * time.Second
	diagAITimeout  = 30 * time.Second
	// diagLookupTimeout bounds the extra DNS lookup made for a failed check
	// that did not resolve the host itself (reused connection, proxy).
	diagLookupTimeout = 3 * time.Second
)

// diagDetail is the technical side of a check (all optional): the layer
// that failed and the underlying error, and what the running process is
// configured with (proxy environment, a fingerprint of the key), so the
// operator can tell a network problem from a key problem. Keys are never
// included.
type diagDetail struct {
	Host   string   `json:"host,omitempty"`
	Layer  string   `json:"layer,omitempty"`  // dns / proxy / connect / tls / timeout / network / http / api / response / slow
	Status int      `json:"status,omitempty"` // HTTP status of a failed call
	Detail string   `json:"detail,omitempty"` // the underlying error or the provider's message, keys redacted
	Addrs  []string `json:"addrs,omitempty"`  // addresses the service's host resolved to
	// ProxyAddrs: addresses the proxy's host resolved to (the failed call
	// went through a proxy).
	ProxyAddrs []string `json:"proxy_addrs,omitempty"`
	Remote     string   `json:"remote,omitempty"` // address connected to (the proxy's, through a proxy)
	// Blocked: an error status whose body is not the provider's own error
	// (a proxy, firewall or WAF page), so not a verdict on the key.
	Blocked bool             `json:"blocked,omitempty"`
	Proxy   *netdiag.Proxy   `json:"proxy,omitempty"` // only when a proxy variable is set
	KeyHint *netdiag.KeyHint `json:"key_hint,omitempty"`
}

type amapDiag struct {
	Configured bool   `json:"configured"`
	OK         bool   `json:"ok"`
	Message    string `json:"message"`
	Infocode   string `json:"infocode,omitempty"`
	LatencyMS  int64  `json:"latency_ms"`
	diagDetail
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
	Kind       string `json:"kind,omitempty"` // auth / balance / model / rate_limit / server / network / timeout…
	diagDetail
}

type tiandituDiag struct {
	Configured bool   `json:"configured"`
	OK         bool   `json:"ok"`
	Message    string `json:"message"`
	LatencyMS  int64  `json:"latency_ms"`
	diagDetail
}

func okMessage(d time.Duration) string {
	return fmt.Sprintf("正常（用时 %d 毫秒）", d.Milliseconds())
}

func hostOfURL(raw string) string {
	if u, err := url.Parse(raw); err == nil && u.Host != "" {
		return u.Host
	}
	return raw
}

// newDiagDetail describes a configured service at target (its URL).
func newDiagDetail(target string, hint netdiag.KeyHint) diagDetail {
	d := diagDetail{Host: hostOfURL(target), KeyHint: &hint}
	if p := netdiag.Proxies(target); p.Set() || p.Used != "" {
		d.Proxy = &p
	}
	return d
}

// fail fills the failure part from the explanation x of err and, when the
// check did not resolve the host itself, looks it up so the operator sees
// whether DNS works.
func (d *diagDetail) fail(ctx context.Context, x netdiag.Details, err error) {
	if x.Detail == "" && err != nil {
		x.Detail = err.Error() // not an error of the client package (e.g. an undecodable answer)
	}
	d.Layer, d.Status, d.Detail, d.Addrs, d.Remote = x.Layer, x.Status, x.Detail, x.Addrs, x.Remote
	d.ProxyAddrs, d.Blocked = x.ProxyAddrs, x.Blocked
	if !netdiag.IsNetwork(d.Layer) || d.Layer == netdiag.LayerDNS || len(d.Addrs) > 0 || d.Host == "" {
		return
	}
	host := d.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	if net.ParseIP(host) != nil {
		return
	}
	lctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), diagLookupTimeout)
	defer cancel()
	if addrs, err := net.DefaultResolver.LookupHost(lctx, host); err == nil {
		d.Addrs = addrs
	}
}

// logFailure writes a failed check to the log, so `docker compose logs app`
// shows it too.
func (d *diagDetail) logFailure(service, message string) {
	args := []any{"service", service, "layer", d.Layer, "message", message, "detail", d.Detail}
	if d.Status != 0 {
		args = append(args, "status", d.Status)
	}
	if len(d.Addrs) > 0 {
		args = append(args, "addrs", strings.Join(d.Addrs, ","))
	}
	if len(d.ProxyAddrs) > 0 {
		args = append(args, "proxy_addrs", strings.Join(d.ProxyAddrs, ","))
	}
	if d.Blocked {
		args = append(args, "blocked", true)
	}
	if d.Proxy != nil {
		args = append(args, "proxy", d.Proxy.Text(), "proxy_used", d.Proxy.Used)
	}
	if d.KeyHint != nil {
		args = append(args, "key", d.KeyHint.Text)
	}
	slog.Warn("diagnostics check failed", args...)
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
		am.diagDetail = newDiagDetail(h.svc.Amap.BaseURL(), h.svc.Amap.KeyHint())
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
			am.fail(ctx, amap.Details(err), err)
			am.logFailure("amap", am.Message)
		}()
	}

	cli := h.svc.AI
	ad = aiDiag{Configured: cli.Enabled(), Model: cli.Model(), BaseURL: netdiag.RedactURL(cli.BaseURL()), Thinking: cli.Thinking(),
		TimeoutS: int(h.cfg.AITimeout.Seconds())}
	if !ad.Configured {
		ad.Message = "未配置 AI（AI_BASE_URL 和 AI_MODEL）"
	} else {
		ad.diagDetail = newDiagDetail(cli.Endpoint(), cli.KeyHint())
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
				var e *ai.Error
				if errors.As(err, &e) {
					ad.Kind = e.KindName()
				}
				ad.fail(ctx, ai.Details(err), err)
				ad.logFailure("ai", ad.Message)
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
		td.diagDetail = newDiagDetail(h.svc.Tianditu.BaseURL(), h.svc.Tianditu.KeyHint())
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
			td.fail(ctx, tianditu.Details(err), err)
			td.logFailure("tianditu", td.Message)
		}()
	}
	wg.Wait()
	c.JSON(http.StatusOK, gin.H{"amap": am, "ai": ad, "tianditu": td})
	return nil
}
