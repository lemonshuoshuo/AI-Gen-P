package amap

import (
	"errors"
	"fmt"
	"net/url"
	"sync/atomic"
	"time"
)

// Error is a failed AMap call: an answer with status "0" (Infocode / Info),
// an HTTP error status or a network failure. It wraps ErrUnavailable.
type Error struct {
	Infocode   string // AMap infocode, e.g. "10009"; "" for HTTP / network errors
	Info       string // AMap info, e.g. "USERKEY_PLAT_NOMATCH", or the error text (never the key)
	HTTPStatus int    // non-200 HTTP status
	Network    bool   // cannot reach AMap (or it did not answer in time)
	Host       string // the API host, for network errors
	// Paused: this call was not sent because an earlier failure (this
	// error) paused calls for a while.
	Paused bool
}

func (e *Error) Error() string {
	var s string
	switch {
	case e.Infocode != "":
		s = fmt.Sprintf("amap error %s: %s", e.Infocode, e.Info)
	case e.HTTPStatus != 0:
		s = fmt.Sprintf("http %d", e.HTTPStatus)
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
		return "高德 Key 无效，请检查 .env 中的 AMAP_KEY"
	case "10009":
		return "高德 Key 的服务平台不是「Web服务」：请在高德控制台为本站创建服务平台为「Web服务」的 Key"
	case "10005":
		return "服务器 IP 不在高德 Key 的白名单中"
	case "10003", "10044":
		return "高德调用额度已用完"
	case "10041":
		return "高德调用额度已用完（或该接口的使用权限已过期）"
	case "10012":
		return "该 Key 没有此接口权限"
	case "10002":
		return "该 Key 没有此服务的权限，请确认 Key 的服务平台为「Web服务」"
	case "10013":
		return "高德 Key 已被删除，请检查 .env 中的 AMAP_KEY"
	case "10026":
		return "高德账号已被封禁"
	case "10004", "10010", "10014", "10019", "10020", "10021":
		return fmt.Sprintf("高德接口调用过于频繁，请稍后再试（infocode %s %s）", e.Infocode, e.Info)
	default:
		return fmt.Sprintf("高德接口返回错误（infocode %s %s）", e.Infocode, e.Info)
	}
	switch {
	case e.Network:
		host := e.Host
		if host == "" {
			host = "restapi.amap.com"
		}
		return "服务器无法连接高德（" + host + "）"
	case e.HTTPStatus != 0:
		return fmt.Sprintf("高德接口返回 HTTP %d，请稍后再试", e.HTTPStatus)
	}
	return "高德接口调用失败：" + e.Info
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
