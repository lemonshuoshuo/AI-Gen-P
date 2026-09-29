package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"triphub/internal/ai"
	"triphub/internal/amap"
	"triphub/internal/config"
	"triphub/internal/netdiag"
	"triphub/internal/tianditu"
	"triphub/internal/version"
)

// Timeouts of the -diagnose steps.
var (
	diagStepTimeout = 5 * time.Second  // DNS lookup, TCP connect
	diagTLSTimeout  = 10 * time.Second // TLS handshake
	diagMapTimeout  = 12 * time.Second // AMap / Tianditu API call
	diagAITimeout   = 30 * time.Second // AI API call
)

// diagService is an external service checked by -diagnose.
type diagService struct {
	name   string
	url    string // the URL the client calls
	shown  string // url for the report ("": url); credentials and keys masked
	extra  string // shown after the URL (model…)
	hint   netdiag.KeyHint
	noKey  bool                                      // no key set (allowed for AI)
	call   func(ctx context.Context) (string, error) // the real API call; returns a note on success
	detail func(err error) netdiag.Details
	msg    func(err error) string
	wait   time.Duration
}

// diagPrinter writes the report.
type diagPrinter struct{ w io.Writer }

func (p diagPrinter) line(format string, a ...any) { fmt.Fprintf(p.w, format+"\n", a...) }

// pad pads label to a display width of 8 columns (CJK characters take two).
func pad(label string) string {
	w := 0
	for _, r := range label {
		if r >= 0x1100 {
			w += 2
		} else {
			w++
		}
	}
	return label + strings.Repeat(" ", max(8-w, 1))
}

// step prints one checked step: its label, verdict, duration and text.
func (p diagPrinter) step(label string, ok bool, d time.Duration, text string) {
	verdict := "通过"
	if !ok {
		verdict = "失败"
	}
	p.line("  %s%s %6d ms  %s", pad(label), verdict, d.Milliseconds(), text)
}

func (p diagPrinter) note(label, text string) { p.line("  %s%s", pad(label), text) }

// runDiagnose implements -diagnose: from inside the container (same
// environment, DNS, proxy and network as the server) it checks each
// configured external service step by step (DNS, TCP, TLS) and with one
// real API call through the same client code as the server. It never
// touches the database. It returns the exit code: 0 when every configured
// service works.
func runDiagnose(w io.Writer) int {
	p := diagPrinter{w}
	// Ctrl+C 立即退出：docker compose exec 分配了终端时，信号直接发给本进程，
	// 不自己处理的话要等正在进行的网络请求超时
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sig)
	go func() {
		if _, ok := <-sig; ok {
			fmt.Fprintln(w, "\n已中断")
			os.Exit(130)
		}
	}()
	now := time.Now()
	p.line("TripHub %s 外部服务自检（triphub -diagnose）", version.Version)
	local := now.Format("2006-01-02 15:04:05 MST")
	if loc, err := time.LoadLocation("Asia/Shanghai"); err == nil {
		local = now.In(loc).Format("2006-01-02 15:04:05") + " 北京时间"
	}
	p.line("时间      %s（UTC %s；时间不准会导致 TLS 证书校验失败）", local, now.UTC().Format("15:04:05"))
	cfg, err := config.Load()
	if err != nil {
		p.line("配置错误：%v", err)
		return 1
	}
	px := netdiag.Proxies("")
	p.line("代理      %s", px.Text())
	if ns := nameservers("/etc/resolv.conf"); len(ns) > 0 {
		p.line("DNS       %s（/etc/resolv.conf）", strings.Join(ns, ", "))
	}
	for _, cl := range cfg.Cleaned {
		p.line("注意      %s 的值里有多余的内容（%s），已自动去掉；请修正 .env 中对应的一行", cl.Var, strings.Join(cl.Removed, "、"))
	}

	// Each service in order: nil when not configured (off says why).
	type entry struct {
		name, off string
		svc       *diagService
	}
	var entries []entry
	if cfg.AmapKey != "" {
		c := amap.New(cfg.AmapKey)
		entries = append(entries, entry{name: "高德地图", svc: &diagService{
			name: "高德地图", url: amap.DefaultBaseURL + "/v3/place/text", hint: c.KeyHint(), wait: diagMapTimeout,
			call:   func(ctx context.Context) (string, error) { return "在北京搜索「天安门」", c.Check(ctx) },
			detail: amap.Details, msg: amap.ErrorMessage,
		}})
	} else {
		entries = append(entries, entry{name: "高德地图", off: "未配置（AMAP_KEY 为空）"})
	}
	if cfg.AIEnabled() {
		c := ai.NewClient(ai.Config{BaseURL: cfg.AIBaseURL, APIKey: cfg.AIAPIKey, Model: cfg.AIModel, Timeout: cfg.AITimeout,
			Thinking: cfg.AIThinking, ExtraBody: cfg.AIExtraBody})
		entries = append(entries, entry{name: "AI 模型", svc: &diagService{
			name: "AI 模型", url: c.Endpoint(), shown: netdiag.RedactURL(c.Endpoint(), cfg.AIAPIKey),
			extra: "模型 " + c.Model() + " · 深度思考 " + c.Thinking(),
			hint:  c.KeyHint(), noKey: cfg.AIAPIKey == "", wait: diagAITimeout,
			call: func(ctx context.Context) (string, error) {
				reply, err := c.Ping(ctx)
				if r := []rune(strings.TrimSpace(reply)); len(r) > 20 {
					reply = string(r[:20]) + "…"
				}
				return "模型回复「" + strings.TrimSpace(reply) + "」", err
			},
			detail: ai.Details, msg: ai.UserMessage,
		}})
	} else {
		entries = append(entries, entry{name: "AI 模型", off: "未配置（AI_BASE_URL 与 AI_MODEL 需同时设置）"})
	}
	if cfg.TiandituKey != "" {
		c := tianditu.New(cfg.TiandituKey)
		entries = append(entries, entry{name: "天地图", svc: &diagService{
			name: "天地图", url: tianditu.DefaultBaseURL + "/v2/search", hint: c.KeyHint(), wait: diagMapTimeout,
			call:   func(ctx context.Context) (string, error) { return "在北京搜索「天安门」", c.Check(ctx) },
			detail: tianditu.Details, msg: tianditu.ErrorMessage,
		}})
	} else {
		entries = append(entries, entry{name: "天地图", off: "未配置（TIANDITU_KEY 为空，可选）"})
	}

	var summary []string
	configured, failed := 0, false
	for _, e := range entries {
		if e.svc == nil {
			p.line("")
			p.line("[%s] %s", e.name, e.off)
			summary = append(summary, e.name+" 未配置")
			continue
		}
		configured++
		verdict := "通过"
		if !diagnoseService(p, *e.svc) {
			verdict, failed = "失败", true
		}
		summary = append(summary, e.name+" "+verdict)
	}
	p.line("")
	p.line("结果：%s", strings.Join(summary, " · "))
	if configured == 0 {
		p.line("没有配置任何外部服务。如果 .env 中已经填写，请在部署目录执行 docker compose up -d 重新创建容器（docker compose restart 不会重新读取 .env）。")
	}
	if failed {
		p.line("排查方法见部署目录的 README.md（源码中为 docs/DEPLOY.md）「常见问题」→「系统诊断显示异常，但 Key 确认无误」。")
		return 1
	}
	return 0
}

// diagnoseService checks one service and reports whether its API call works.
func diagnoseService(p diagPrinter, s diagService) bool {
	p.line("")
	shown := s.shown
	if shown == "" {
		shown = s.url
	}
	head := "[" + s.name + "] " + shown
	if s.extra != "" {
		head += " · " + s.extra
	}
	p.line("%s", head)
	if s.noKey {
		p.note("Key", "未设置（AI_API_KEY 为空；本地模型可以不设）")
	} else {
		text := s.hint.Text
		if s.hint.Warning != "" {
			text += " —— " + s.hint.Warning
		}
		p.note("Key", text)
	}
	u, err := url.Parse(s.url)
	if err != nil || u.Host == "" {
		p.note("地址", "无法解析："+shown)
		return false
	}
	host, port := u.Hostname(), u.Port()
	if port == "" {
		port = "443"
		if u.Scheme == "http" {
			port = "80"
		}
	}
	pr := netdiag.Proxies(s.url)
	if pr.Used == "" {
		p.note("代理", "直连（不经过代理）")
	} else {
		p.note("代理", "经 "+pr.Used+" 转发（来自 HTTPS_PROXY / HTTP_PROXY；下面的 DNS / TCP / TLS 是直连测试）")
		probeProxy(p, pr.Used)
	}
	reachable := probeNetwork(p, u.Scheme, host, port)
	// 直连时网络都不通，接口调用必然失败，不必再等它超时
	if !reachable && pr.Used == "" {
		p.note("接口", "跳过（网络检查未通过，先解决上面的问题）")
		return false
	}

	p.note("接口", fmt.Sprintf("调用中…（最长 %d 秒）", int(s.wait.Seconds())))
	ctx, cancel := context.WithTimeout(context.Background(), s.wait)
	defer cancel()
	start := time.Now()
	note, err := s.call(ctx)
	d := time.Since(start)
	if err == nil {
		p.step("接口", true, d, note)
		return true
	}
	msg := s.msg(err)
	if msg == "" {
		msg = err.Error()
	}
	x := s.detail(err)
	layer := ""
	if x.Layer != "" {
		layer = "[" + x.Layer + "] "
	}
	p.step("接口", false, d, layer+msg)
	if x.Status != 0 {
		p.note("", fmt.Sprintf("HTTP 状态  %d", x.Status))
	}
	if x.Detail != "" {
		p.note("", "原始错误  "+x.Detail)
	}
	if len(x.Addrs) > 0 {
		p.note("", "解析地址  "+u.Hostname()+" → "+strings.Join(x.Addrs, ", "))
	}
	if x.Proxy != "" {
		via := x.Proxy
		if len(x.ProxyAddrs) > 0 {
			via += "（代理地址解析为 " + strings.Join(x.ProxyAddrs, ", ") + "）"
		}
		p.note("", "经过代理  "+via)
	}
	if x.Blocked {
		p.note("", "返回的不是服务商的错误信息：请求可能被代理、防火墙或 WAF 拦截，与 Key 无关")
	}
	return false
}

// probeProxy checks that the proxy accepts TCP connections.
func probeProxy(p diagPrinter, proxy string) {
	u, err := url.Parse(proxy)
	if err != nil || u.Host == "" {
		return
	}
	port := u.Port()
	if port == "" {
		switch u.Scheme {
		case "https":
			port = "443"
		case "socks5", "socks5h":
			port = "1080"
		default:
			port = "80"
		}
	}
	addr := net.JoinHostPort(u.Hostname(), port)
	start := time.Now()
	conn, err := (&net.Dialer{Timeout: diagStepTimeout}).Dial("tcp", addr)
	if err != nil {
		p.step("代理 TCP", false, time.Since(start), netdiag.DialReason(err)+"（容器里的 127.0.0.1 是容器自己，不是宿主机）")
		return
	}
	conn.Close()
	p.step("代理 TCP", true, time.Since(start), addr)
}

// probeNetwork checks DNS, a TCP connection and the TLS handshake to
// host:port directly, and reports whether all of them passed.
func probeNetwork(p diagPrinter, scheme, host, port string) bool {
	if net.ParseIP(host) == nil {
		ctx, cancel := context.WithTimeout(context.Background(), diagStepTimeout)
		start := time.Now()
		addrs, err := net.DefaultResolver.LookupHost(ctx, host)
		cancel()
		if err != nil {
			p.step("DNS", false, time.Since(start), netdiag.DNSReason(err))
			return false
		}
		p.step("DNS", true, time.Since(start), host+" → "+strings.Join(addrs, ", "))
	}
	start := time.Now()
	conn, err := (&net.Dialer{Timeout: diagStepTimeout}).Dial("tcp", net.JoinHostPort(host, port))
	if err != nil {
		p.step("TCP", false, time.Since(start), netdiag.DialReason(err))
		// 容器里的 DNS 由宿主机上的 Docker 代为查询，所以 DNS 通过而 TCP 不通时，
		// 多半是宿主机的 Docker 转发 / NAT 规则丢了
		target := scheme + "://" + host
		if (scheme == "https" && port != "443") || (scheme == "http" && port != "80") {
			target = scheme + "://" + net.JoinHostPort(host, port)
		}
		p.note("", "对比：在宿主机上执行 curl -sS -m 8 -o /dev/null -w '%{http_code}\\n' "+target)
		p.note("", "宿主机能连、容器不能：Docker 的转发 / NAT 规则失效（执行 systemctl restart docker，再在部署目录 docker compose up -d），")
		p.note("", "或宿主机的 ufw、Clash / mihomo 的 TUN 模式拦截了容器流量，见 README「常见问题」→「DNS 通过、TCP 超时」")
		return false
	}
	defer conn.Close()
	p.step("TCP", true, time.Since(start), conn.RemoteAddr().String())
	if scheme != "https" {
		p.note("TLS", "跳过（"+scheme+" 地址）")
		return true
	}
	ctx, cancel := context.WithTimeout(context.Background(), diagTLSTimeout)
	defer cancel()
	start = time.Now()
	tc := tls.Client(conn, &tls.Config{ServerName: host})
	if err := tc.HandshakeContext(ctx); err != nil {
		p.step("TLS", false, time.Since(start), netdiag.TLSReason(err)+"："+err.Error())
		return false
	}
	p.step("TLS", true, time.Since(start), certSummary(tc.ConnectionState()))
	return true
}

// certSummary describes the server certificate of a TLS connection.
func certSummary(cs tls.ConnectionState) string {
	s := tls.VersionName(cs.Version)
	if len(cs.PeerCertificates) == 0 {
		return s
	}
	c := cs.PeerCertificates[0]
	issuer := c.Issuer.CommonName
	if issuer == "" && len(c.Issuer.Organization) > 0 {
		issuer = c.Issuer.Organization[0]
	}
	s += " · 证书 " + c.Subject.CommonName + " · 签发者 " + issuer + " · 有效期至 " + c.NotAfter.Format("2006-01-02")
	if now := time.Now(); now.Before(c.NotBefore) || now.After(c.NotAfter) {
		s += "（按本机时间证书无效，请检查系统时间）"
	}
	return s
}

// nameservers reads the nameserver lines of a resolv.conf.
func nameservers(path string) []string {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) >= 2 && fields[0] == "nameserver" {
			out = append(out, fields[1])
		}
	}
	return out
}
