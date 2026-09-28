// Package netdiag explains failed outbound HTTPS calls (AMap, the AI model,
// Tianditu) for operators: which layer failed (DNS, proxy, TCP connect,
// TLS, no response), the Go error with keys redacted, the proxy settings the
// process runs with and a fingerprint of a configured key. The API clients
// use it to classify their network errors; the admin diagnostics and
// `triphub -diagnose` show the result.
package netdiag

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"os"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Layers of a failed call, from the network up.
const (
	LayerDNS     = "dns"      // the host name did not resolve
	LayerProxy   = "proxy"    // the HTTP(S)_PROXY could not be used
	LayerConnect = "connect"  // no TCP connection
	LayerTLS     = "tls"      // TLS handshake or certificate
	LayerTimeout = "timeout"  // connected and sent, no answer in time
	LayerNetwork = "network"  // the connection broke, or an unknown network error
	LayerHTTP    = "http"     // an HTTP error status
	LayerAPI     = "api"      // the provider answered with an error code
	LayerReply   = "response" // an answer that is not the provider's (not JSON, not a usable result)
	// LayerSlow: the answer had started but did not finish in time (a slow
	// or busy model), not a network failure.
	LayerSlow = "slow"
)

// IsNetwork reports whether layer is a network-level failure (the service
// was not reached, or did not answer), as opposed to an answer with an error.
func IsNetwork(layer string) bool {
	switch layer {
	case LayerDNS, LayerProxy, LayerConnect, LayerTLS, LayerTimeout, LayerNetwork:
		return true
	}
	return false
}

// Trace records how far an HTTP request got (DNS, connect, TLS, request
// written, first response byte). It is safe for concurrent use: the
// transport may still report a dial after the request gave up.
type Trace struct {
	mu    sync.Mutex
	start time.Time
	in    TraceInfo
}

// TraceInfo is a snapshot of a Trace.
type TraceInfo struct {
	DNSHost        string
	DNSStarted     bool
	DNSDone        bool
	DNSErr         error
	Addrs          []string // resolved addresses
	ConnectStarted bool
	Connected      bool   // a TCP connection succeeded
	ConnectAddr    string // the address dialled (last)
	ConnectErr     error
	TLSStarted     bool
	TLSDone        bool // the handshake finished (see TLSErr)
	TLSErr         error
	GotConn        bool
	Reused         bool
	Remote         string // remote address of the connection used
	WroteRequest   bool
	FirstByte      bool
	Elapsed        time.Duration
}

// NewTrace starts a trace.
func NewTrace() *Trace { return &Trace{start: time.Now()} }

func (t *Trace) update(f func(*TraceInfo)) {
	t.mu.Lock()
	f(&t.in)
	t.mu.Unlock()
}

// Context returns ctx with the trace attached (hooks already in ctx are
// still called). A nil trace returns ctx.
func (t *Trace) Context(ctx context.Context) context.Context {
	if t == nil {
		return ctx
	}
	return httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{
		DNSStart: func(i httptrace.DNSStartInfo) {
			t.update(func(in *TraceInfo) { in.DNSStarted, in.DNSHost = true, i.Host })
		},
		DNSDone: func(i httptrace.DNSDoneInfo) {
			t.update(func(in *TraceInfo) {
				in.DNSDone, in.DNSErr = true, i.Err
				in.Addrs = in.Addrs[:0]
				for _, a := range i.Addrs {
					in.Addrs = append(in.Addrs, a.String())
				}
			})
		},
		ConnectStart: func(_, addr string) {
			t.update(func(in *TraceInfo) { in.ConnectStarted, in.ConnectAddr = true, addr })
		},
		ConnectDone: func(_, addr string, err error) {
			t.update(func(in *TraceInfo) {
				if err == nil {
					in.Connected, in.ConnectAddr, in.ConnectErr = true, addr, nil
				} else if !in.Connected {
					in.ConnectErr, in.ConnectAddr = err, addr
				}
			})
		},
		TLSHandshakeStart: func() { t.update(func(in *TraceInfo) { in.TLSStarted = true }) },
		TLSHandshakeDone: func(_ tls.ConnectionState, err error) {
			t.update(func(in *TraceInfo) { in.TLSDone, in.TLSErr = true, err })
		},
		GotConn: func(i httptrace.GotConnInfo) {
			t.update(func(in *TraceInfo) {
				in.GotConn, in.Reused = true, i.Reused
				if i.Conn != nil && i.Conn.RemoteAddr() != nil {
					in.Remote = i.Conn.RemoteAddr().String()
				}
			})
		},
		WroteRequest: func(i httptrace.WroteRequestInfo) {
			if i.Err == nil {
				t.update(func(in *TraceInfo) { in.WroteRequest = true })
			}
		},
		GotFirstResponseByte: func() { t.update(func(in *TraceInfo) { in.FirstByte = true }) },
	})
}

// Info returns a snapshot; the zero TraceInfo for a nil trace.
func (t *Trace) Info() TraceInfo {
	if t == nil {
		return TraceInfo{}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	in := t.in
	in.Addrs = append([]string(nil), t.in.Addrs...)
	in.Elapsed = time.Since(t.start)
	return in
}

// Failure is a classified network failure.
type Failure struct {
	Layer  string   // one of the network layers (see IsNetwork)
	Reason string   // what failed, in Chinese
	Addrs  []string // addresses the host resolved to, if DNS ran (direct connections only)
	// ProxyAddrs are the addresses the proxy's host resolved to: through a
	// proxy the client resolves the proxy, never the target host.
	ProxyAddrs []string
	Remote     string // the address connected to (the proxy's, through a proxy), if any
	Proxy      string // the proxy used (redacted), "" for a direct connection
}

// ProxyOf returns the proxy client would use for req (nil: direct).
func ProxyOf(client *http.Client, req *http.Request) *url.URL {
	var rt http.RoundTripper = http.DefaultTransport
	if client != nil && client.Transport != nil {
		rt = client.Transport
	}
	if t, ok := rt.(*http.Transport); ok && t.Proxy != nil && req != nil {
		if u, err := t.Proxy(req); err == nil {
			return u
		}
	}
	return nil
}

// Classify explains err, returned by an HTTP client for a request traced
// by t (may be nil) and sent through proxy (nil: direct).
func Classify(err error, t *Trace, proxy *url.URL) *Failure {
	in := t.Info()
	f := &Failure{Addrs: in.Addrs, Remote: in.Remote}
	if f.Remote == "" && in.Connected {
		f.Remote = in.ConnectAddr
	}
	if proxy != nil {
		// The lookups in the trace were of the proxy's host.
		f.Proxy, f.ProxyAddrs, f.Addrs = RedactProxy(proxy.String()), f.Addrs, nil
	}
	cause := short(err)
	var op *net.OpError
	isOp := errors.As(err, &op)
	var dnsErr *net.DNSError
	switch {
	case (isOp && op.Op == "proxyconnect") || (proxy != nil && !in.TLSStarted && !in.GotConn):
		// Dialling the proxy, or its CONNECT, failed.
		f.Layer = LayerProxy
		switch {
		case errors.As(err, &dnsErr):
			cause = "代理地址解析失败：" + dnsReason(dnsErr)
		case cause == "" && err != nil:
			cause = lastPart(err)
		}
		name := f.Proxy
		if name == "" {
			name = "（环境变量中的代理）"
		}
		f.Reason = fmt.Sprintf("经代理 %s 连接失败：%s（代理来自环境变量 HTTPS_PROXY / HTTP_PROXY，Docker 会把 ~/.docker/config.json 的 proxies 注入容器）", name, cause)
	case errors.As(err, &dnsErr):
		f.Layer, f.Reason = LayerDNS, "域名解析失败："+dnsReason(dnsErr)
	case in.DNSErr != nil && !in.Connected:
		f.Layer = LayerDNS
		if errors.As(in.DNSErr, &dnsErr) {
			f.Reason = "域名解析失败：" + dnsReason(dnsErr)
		} else {
			f.Reason = "域名解析失败：" + in.DNSErr.Error()
		}
	case certError(err) != "":
		f.Layer, f.Reason = LayerTLS, certError(err)
	case in.TLSErr != nil && certError(in.TLSErr) != "":
		f.Layer, f.Reason = LayerTLS, certError(in.TLSErr)
	case strings.Contains(errText(err), "TLS handshake timeout") ||
		(in.TLSStarted && !in.GotConn && (!in.TLSDone || in.TLSErr != nil) && IsTimeout(err)):
		f.Layer = LayerTLS
		f.Reason = "TLS 握手超时：TCP 已连通但握手没有完成，常见于 MTU 不匹配（云服务器 / VPN 网卡 MTU 小于 1500）或防火墙拦截"
	case in.TLSErr != nil || (in.TLSStarted && !in.TLSDone):
		f.Layer = LayerTLS
		e := in.TLSErr
		if e == nil {
			e = err
		}
		f.Reason = "TLS 握手失败：" + orText(short(e), lastPart(e)) + "（可能被防火墙或 HTTPS 劫持拦截）"
	case isOp && op.Op == "dial":
		if in.ConnectAddr == "" && op.Addr != nil {
			in.ConnectAddr = op.Addr.String()
		}
		f.Layer, f.Reason = LayerConnect, connectReason(cause, in)
	case !in.GotConn && in.DNSStarted && !in.DNSDone:
		f.Layer, f.Reason = LayerDNS, "域名解析超时：DNS 服务器没有响应（检查容器的 DNS 设置）"
	case !in.GotConn && in.ConnectStarted && !in.Connected:
		f.Layer, f.Reason = LayerConnect, connectReason(cause, in)
	case !in.GotConn:
		f.Layer = LayerConnect
		if IsTimeout(err) {
			f.Reason = "连接超时：没有建立任何连接"
		} else {
			f.Reason = "无法建立连接：" + orText(cause, lastPart(err))
		}
	case !in.FirstByte && IsTimeout(err):
		f.Layer = LayerTimeout
		f.Reason = fmt.Sprintf("已连接并发出请求，但 %d 秒内没有收到任何响应", seconds(in.Elapsed))
	case IsTimeout(err):
		f.Layer = LayerTimeout
		f.Reason = fmt.Sprintf("读取响应超时（已等待 %d 秒）", seconds(in.Elapsed))
	default:
		f.Layer = LayerNetwork
		f.Reason = "连接被中断：" + orText(cause, lastPart(err))
	}
	return f
}

func seconds(d time.Duration) int { return int(math.Round(d.Seconds())) }

func orText(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// lastPart is the innermost part of an error text ("dial tcp 1.2.3.4:443:
// connect: connection refused" → "connection refused").
func lastPart(err error) string {
	s := errText(err)
	if i := strings.LastIndex(s, ": "); i >= 0 && i+2 < len(s) {
		return s[i+2:]
	}
	return s
}

func connectReason(cause string, in TraceInfo) string {
	addr := in.ConnectAddr
	if addr != "" {
		addr = " " + addr + " "
	}
	switch cause {
	case "":
		return "TCP 连接" + addr + "失败"
	case "超时":
		return "TCP 连接" + addr + "超时：出站流量可能被防火墙、安全组或 Docker 的 NAT（iptables）规则拦截"
	}
	return "TCP 连接" + addr + "失败：" + cause
}

// IsTimeout reports whether err is a timeout or a deadline.
func IsTimeout(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, os.ErrDeadlineExceeded) {
		return true
	}
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

// short names common socket errors in Chinese ("" if none matches).
func short(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, syscall.ECONNREFUSED):
		return "连接被拒绝（connection refused）"
	case errors.Is(err, syscall.ECONNRESET):
		return "连接被重置（connection reset）"
	case errors.Is(err, syscall.ENETUNREACH):
		return "网络不可达（network is unreachable）"
	case errors.Is(err, syscall.EHOSTUNREACH):
		return "主机不可达（no route to host）"
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		return "对方关闭了连接（EOF）"
	case IsTimeout(err):
		return "超时"
	}
	return ""
}

func dnsReason(e *net.DNSError) string {
	server := ""
	if e.Server != "" {
		server = "（DNS 服务器 " + e.Server + "）"
	}
	switch {
	case e.IsNotFound:
		return e.Name + " 不存在（no such host）" + server + "：检查容器的 DNS 设置"
	case e.IsTimeout:
		return "查询 " + e.Name + " 超时" + server + "：DNS 服务器没有响应"
	}
	return e.Name + "：" + e.Err + server
}

// certError explains certificate verification errors ("" for others).
func certError(err error) string {
	var ua x509.UnknownAuthorityError
	var ci x509.CertificateInvalidError
	var he x509.HostnameError
	var cv *tls.CertificateVerificationError
	switch {
	case errors.As(err, &ci) && ci.Reason == x509.Expired:
		return "TLS 证书已过期或尚未生效：多半是服务器时间不对，请检查系统时间（timedatectl）"
	case errors.As(err, &ua):
		return "TLS 证书不受信任（unknown authority）：连接可能被代理或防火墙做了 HTTPS 劫持"
	case errors.As(err, &he):
		return "TLS 证书与域名不符：可能被 DNS 劫持到了其它服务器，或被代理拦截"
	case errors.As(err, &ci), errors.As(err, &cv):
		return "TLS 证书校验失败：" + lastPart(err)
	}
	return ""
}

// TLSReason explains a failed TLS handshake (for step-by-step probes).
func TLSReason(err error) string {
	if s := certError(err); s != "" {
		return s
	}
	if IsTimeout(err) {
		return "TLS 握手超时：TCP 已连通但握手没有完成，常见于 MTU 不匹配或防火墙拦截"
	}
	return "TLS 握手失败：" + orText(short(err), lastPart(err))
}

// DialReason explains a failed TCP dial (for step-by-step probes).
func DialReason(err error) string {
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "域名解析失败：" + dnsReason(dnsErr)
	}
	in := TraceInfo{}
	var op *net.OpError
	if errors.As(err, &op) && op.Addr != nil {
		in.ConnectAddr = op.Addr.String()
	}
	return connectReason(short(err), in)
}

// DNSReason explains a failed lookup (for step-by-step probes).
func DNSReason(err error) string {
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "域名解析失败：" + dnsReason(dnsErr)
	}
	return "域名解析失败：" + errText(err)
}

// Details is what the admin diagnostics show about a failed check.
type Details struct {
	Layer      string   // see the Layer constants
	Status     int      // HTTP status, if any
	Detail     string   // the underlying error or the provider's message (keys redacted)
	Addrs      []string // addresses the host resolved to
	ProxyAddrs []string // addresses the proxy's host resolved to
	Remote     string   // address connected to
	Proxy      string   // proxy used (redacted)
	// Blocked: an error status whose body is not the provider's error (a
	// proxy, firewall or WAF page), so not a verdict on the key.
	Blocked bool
}

// FromFailure fills the network part of Details.
func FromFailure(f *Failure, detail string) Details {
	d := Details{Layer: LayerNetwork, Detail: detail}
	if f != nil {
		d.Layer, d.Addrs, d.ProxyAddrs, d.Remote, d.Proxy = f.Layer, f.Addrs, f.ProxyAddrs, f.Remote, f.Proxy
	}
	return d
}
