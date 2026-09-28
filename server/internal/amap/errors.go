package amap

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"triphub/internal/netdiag"
)

// Error is a failed AMap call: an answer with status "0" (Infocode / Info),
// an HTTP error status or a network failure. It wraps ErrUnavailable.
type Error struct {
	Infocode   string // AMap infocode, e.g. "10009"; "" for HTTP / network errors
	Info       string // AMap info, e.g. "USERKEY_PLAT_NOMATCH", or the error text (never the key)
	HTTPStatus int    // non-200 HTTP status
	Network    bool   // cannot reach AMap (or it did not answer in time)
	// BadReply: a 200 answer that is not AMap's JSON (a captive portal, a
	// proxy or WAF page); Info holds a snippet of it.
	BadReply bool
	Host     string // the API host, for network errors
	// Net tells which layer of a network error failed (DNS, proxy,
	// connect, TLS, no answer); nil for other errors.
	Net *netdiag.Failure
	// Paused: this call was not sent because an earlier failure (this
	// error) paused calls for a while.
	Paused bool
	// cut: the caller's own deadline, shorter than the client's timeout,
	// ended this network failure (it does not count towards a pause).
	cut bool
}

func (e *Error) Error() string {
	var s string
	switch {
	case e.Infocode != "":
		s = fmt.Sprintf("amap error %s: %s", e.Infocode, e.Info)
	case e.HTTPStatus != 0:
		s = fmt.Sprintf("http %d", e.HTTPStatus)
		if e.Info != "" {
			s += ": " + e.Info
		}
	case e.BadReply:
		s = "not an amap answer: " + e.Info
	default:
		s = e.Info
	}
	if e.Paused {
		s = "paused after " + s
	}
	return ErrUnavailable.Error() + ": " + s
}

func (e *Error) Unwrap() error { return ErrUnavailable }

// Message explains the failure in Chinese, with what the operator can do.
func (e *Error) Message() string {
	msg := e.message()
	if e.Paused {
		msg += "（已暂停调用高德，稍后自动重试）"
	}
	return msg
}

func (e *Error) message() string {
	switch e.Infocode {
	case "":
	case "10001":
		return "高德 Key 无效（infocode 10001 INVALID_USER_KEY）：请检查 .env 中的 AMAP_KEY 是否完整、没有多余的引号、空格或注释"
	case "10009":
		return "高德 Key 的服务平台不是「Web服务」：请在高德控制台为本站创建服务平台为「Web服务」的 Key"
	case "10005":
		return "服务器 IP 不在高德 Key 的白名单中（infocode 10005）：在高德控制台把服务器公网 IP 加入白名单，或清空白名单"
	case "10006":
		return "高德 Key 绑定了域名（infocode 10006）：服务端调用请使用未绑定域名的「Web服务」Key"
	case "10007":
		return "高德 Key 开启了数字签名（infocode 10007 INVALID_USER_SIGNATURE）：本站不支持签名，请在控制台关闭该 Key 的数字签名"
	case "10008":
		return "高德 Key 的安全码校验未通过（infocode 10008）：请使用「Web服务」Key，并关闭安全密钥校验"
	case "10003", "10044":
		return "高德调用额度已用完（infocode " + e.Infocode + "），次日零点恢复，或在控制台提升配额"
	case "10041":
		return "高德调用额度已用完（或该接口的使用权限已过期）"
	case "10012":
		return "该 Key 没有此接口权限（infocode 10012）"
	case "10002":
		return "该 Key 没有此服务的权限，请确认 Key 的服务平台为「Web服务」（infocode 10002）"
	case "10011":
		return "高德接口不支持 HTTPS 访问（infocode 10011）"
	case "10013":
		return "高德 Key 已被删除，请检查 .env 中的 AMAP_KEY"
	case "10026":
		return "高德账号已被封禁"
	case "10016", "10017":
		return fmt.Sprintf("高德服务暂时不可用（infocode %s %s），请稍后再试", e.Infocode, e.Info)
	case "10004", "10010", "10014", "10015", "10019", "10020", "10021", "10029":
		return fmt.Sprintf("高德接口调用过于频繁，请稍后再试（infocode %s %s）", e.Infocode, e.Info)
	case "10045", "40003":
		return fmt.Sprintf("高德海外服务额度已用完（infocode %s %s）", e.Infocode, e.Info)
	case "40000":
		return "高德付费额度已用完（infocode 40000 QUOTA_PLAN_RUN_OUT），请在控制台续费或提升配额"
	case "40002":
		return "高德购买的服务已到期（infocode 40002 SERVICE_EXPIRED）"
	case "20000", "20001", "20002":
		return fmt.Sprintf("高德认为请求参数有误（infocode %s %s）", e.Infocode, e.Info)
	case "20012":
		return "查询内容包含高德不允许的信息（infocode 20012）"
	default:
		if len(e.Infocode) == 5 && e.Infocode[0] == '3' {
			return fmt.Sprintf("高德服务内部错误（infocode %s %s），请稍后再试", e.Infocode, e.Info)
		}
		return fmt.Sprintf("高德接口返回错误（infocode %s %s）", e.Infocode, e.Info)
	}
	switch {
	case e.Network:
		host := e.Host
		if host == "" {
			host = "restapi.amap.com"
		}
		switch {
		case e.Net == nil:
			return "服务器无法连接高德（" + host + "）"
		case e.Net.Layer == netdiag.LayerTimeout:
			return "高德接口响应超时（" + host + "）：" + e.Net.Reason
		}
		return "服务器无法连接高德（" + host + "）：" + e.Net.Reason
	case e.HTTPStatus != 0:
		msg := fmt.Sprintf("高德接口返回 HTTP %d，请稍后再试", e.HTTPStatus)
		if e.Info != "" && !strings.HasPrefix(strings.TrimSpace(e.Info), "{") {
			// Not AMap's JSON: an answer from something in between.
			msg = fmt.Sprintf("高德接口返回 HTTP %d，且返回的不是高德的数据：可能被代理、防火墙或网关拦截（%s）", e.HTTPStatus, e.Info)
		}
		return msg
	case e.BadReply:
		return "高德接口返回的不是高德的数据：可能被代理、防火墙、WAF 或网络认证页面拦截（" + e.Info + "）"
	}
	return "高德接口调用失败：" + e.Info
}

// Layer tells what failed: a network layer (see netdiag), "http" or "api".
func (e *Error) Layer() string {
	switch {
	case e.Network && e.Net != nil:
		return e.Net.Layer
	case e.Network:
		return netdiag.LayerNetwork
	case e.HTTPStatus != 0:
		return netdiag.LayerHTTP
	case e.BadReply:
		return netdiag.LayerReply
	}
	return netdiag.LayerAPI
}

// Details explains err for the admin diagnostics; the zero Details when
// err is not an *Error.
func Details(err error) netdiag.Details {
	var e *Error
	if !errors.As(err, &e) {
		return netdiag.Details{}
	}
	switch {
	case e.Network:
		return netdiag.FromFailure(e.Net, e.Info)
	case e.HTTPStatus != 0:
		return netdiag.Details{Layer: netdiag.LayerHTTP, Status: e.HTTPStatus, Detail: e.Info,
			Blocked: e.Info != "" && !strings.HasPrefix(strings.TrimSpace(e.Info), "{")}
	case e.BadReply:
		return netdiag.Details{Layer: netdiag.LayerReply, Detail: e.Info, Blocked: true}
	}
	return netdiag.Details{Layer: netdiag.LayerAPI, Detail: "infocode " + e.Infocode + ": " + e.Info}
}

// ErrorMessage explains an error returned by this package in Chinese; it is
// "" when there is nothing to report (no key configured, caller cancelled).
func ErrorMessage(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Message()
	}
	return ""
}

// ErrorCode returns the AMap infocode of err, if any.
func ErrorCode(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Infocode
	}
	return ""
}

// breaker pauses calls for a while after failures that would repeat (bad
// key, quota, network) and remembers the failure for the paused calls.
type breaker struct {
	until atomic.Int64 // unix nanos
	last  atomic.Pointer[Error]
}

func (b *breaker) open(d time.Duration, e *Error) {
	b.last.Store(e)
	b.until.Store(time.Now().Add(d).UnixNano())
}

func (b *breaker) close() { b.until.Store(0) }

func (b *breaker) isOpen() bool { return time.Now().UnixNano() < b.until.Load() }

// err returns the error for a call made while the breaker is open.
func (b *breaker) err() error {
	last := b.last.Load()
	if last == nil {
		return ErrUnavailable
	}
	cp := *last
	cp.Paused = true
	return &cp
}

func hostOf(base string) string {
	if u, err := url.Parse(base); err == nil && u.Host != "" {
		return u.Host
	}
	return base
}
