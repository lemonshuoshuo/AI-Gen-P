package ai

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"triphub/internal/netdiag"
)

// Kind classifies a failed AI call.
type Kind int

// Kinds of Error.
const (
	KindProvider    Kind = iota // an error object in a 2xx answer
	KindAuth                    // 401 / 403: bad key or no permission
	KindBalance                 // 402: account balance used up
	KindModel                   // the model does not exist
	KindRateLimit               // 429
	KindRequest                 // other 4xx
	KindServer                  // 5xx
	KindTimeout                 // no (complete) answer before the deadline
	KindCanceled                // the caller went away
	KindNetwork                 // cannot connect / connection broken
	KindBadResponse             // not a chat completion
	KindEmpty                   // no answer text (e.g. only reasoning)
)

var kindNames = map[Kind]string{
	KindProvider: "provider", KindAuth: "auth", KindBalance: "balance", KindModel: "model",
	KindRateLimit: "rate_limit", KindRequest: "request", KindServer: "server", KindTimeout: "timeout",
	KindCanceled: "canceled", KindNetwork: "network", KindBadResponse: "bad_response", KindEmpty: "empty",
}

// Error is a failed call. Error() is for logs; Message() is a Chinese
// explanation that can be shown to users and operators.
type Error struct {
	Kind   Kind
	Status int    // HTTP status, 0 if none
	Detail string // the provider's message or the underlying error (never the key)
	// Net tells which layer of a network error failed (DNS, proxy,
	// connect, TLS); nil for other kinds.
	Net *netdiag.Failure

	model    string
	host     string
	waited   time.Duration
	reasoned bool
	// noResponse: a timeout after the request was sent, before any byte of
	// the answer (a network problem as often as a slow model).
	noResponse bool
	// blocked: a 403 that is not the provider's JSON error (a proxy,
	// firewall or gateway page).
	blocked bool
	err     error
}

// KindName names the kind for logs and the admin diagnostics ("auth",
// "balance", "network"…).
func (e *Error) KindName() string { return kindNames[e.Kind] }

// Layer tells what failed: a network layer (see netdiag), "timeout" (no
// byte of the answer in time), "slow" (the answer had started but did not
// finish in time: a slow model, not the network), "http" (an error
// status), "api" (an error in a 2xx answer) or "response" (not a usable
// answer); "" for a cancelled call.
func (e *Error) Layer() string {
	switch e.Kind {
	case KindNetwork:
		if e.Net != nil {
			return e.Net.Layer
		}
		return netdiag.LayerNetwork
	case KindTimeout:
		if e.noResponse {
			return netdiag.LayerTimeout
		}
		return netdiag.LayerSlow
	case KindCanceled:
		return ""
	case KindBadResponse, KindEmpty:
		return netdiag.LayerReply
	}
	if e.Status != 0 {
		return netdiag.LayerHTTP
	}
	return netdiag.LayerAPI
}

// Details explains err for the admin diagnostics.
func Details(err error) netdiag.Details {
	var e *Error
	switch {
	case err == nil:
		return netdiag.Details{}
	case !errors.As(err, &e):
		return netdiag.Details{Detail: err.Error()}
	}
	d := netdiag.FromFailure(e.Net, e.Detail)
	d.Layer, d.Status, d.Blocked = e.Layer(), e.Status, e.blocked
	return d
}

func (e *Error) Error() string {
	s := "ai " + kindNames[e.Kind]
	if e.Status != 0 {
		s += fmt.Sprintf(" (http %d)", e.Status)
	}
	if e.Detail != "" {
		s += ": " + e.Detail
	}
	return s
}

func (e *Error) Unwrap() error { return e.err }

// Message explains the failure in Chinese. A network failure is never
// explained as a bad key or a slow model.
func (e *Error) Message() string {
	status := ""
	if e.Status != 0 {
		status = fmt.Sprintf("HTTP %d", e.Status)
	}
	switch e.Kind {
	case KindAuth:
		return "AI Key 无效或没有权限" + paren(status, truncate(e.Detail, 120)) + "：请检查 .env 中的 AI_API_KEY 是否完整、没有多余的引号或空格"
	case KindBalance:
		if e.deepseek() {
			return "AI 账户余额不足，请在 DeepSeek 平台（platform.deepseek.com）充值" + paren(status, "")
		}
		return "AI 账户余额或额度不足" + paren(status, "") + "，请到模型服务商的控制台充值"
	case KindModel:
		return "模型不存在：" + e.model + paren(status, truncate(e.Detail, 120)) + "，请检查 AI_MODEL"
	case KindRateLimit:
		return "AI 服务请求过于频繁或并发超限（HTTP 429），请稍后再试"
	case KindTimeout:
		secs := int(math.Round(e.waited.Seconds()))
		if e.noResponse {
			return fmt.Sprintf("请求已发出，但 AI 服务（%s）在 %d 秒内没有任何响应：多为网络、代理或防火墙问题（可运行 triphub -diagnose 排查）；"+
				"若服务商要等生成完毕才返回数据，也可能是生成较慢", e.host, secs)
		}
		return fmt.Sprintf("AI 响应超时（等待了 %d 秒），可在设置中换用更快的模型或关闭深度思考", secs)
	case KindCanceled:
		return "请求已取消"
	case KindNetwork:
		switch {
		case e.Net == nil:
			return "无法连接 AI 服务：" + e.host
		case e.Net.Layer == netdiag.LayerNetwork:
			return "与 AI 服务（" + e.host + "）的连接中断：" + e.Net.Reason
		}
		return "无法连接 AI 服务（" + e.host + "）：" + e.Net.Reason
	case KindEmpty:
		if e.reasoned {
			return "AI 只返回了思考过程、没有给出结果（可能是输出长度不够），请重试或关闭深度思考（TRIPHUB_AI_THINKING=off）"
		}
		return "AI 返回了空内容，请重试"
	case KindBadResponse:
		return "AI 服务返回的内容格式不正确，请检查 AI_BASE_URL 是否为 OpenAI 兼容接口"
	case KindServer:
		switch e.Status {
		case http.StatusInternalServerError:
			return "AI 服务内部错误（HTTP 500），请稍后再试"
		case http.StatusServiceUnavailable:
			return "AI 服务繁忙（HTTP 503，服务器过载），请稍后再试"
		case http.StatusBadGateway, http.StatusGatewayTimeout:
			return fmt.Sprintf("AI 服务网关错误（HTTP %d），请稍后再试；经代理访问时也可能是代理出错", e.Status)
		}
		return fmt.Sprintf("AI 服务暂时不可用（HTTP %d），请稍后再试", e.Status)
	case KindRequest:
		if e.blocked {
			return fmt.Sprintf("AI 服务拒绝访问（HTTP %d），且返回的不是服务商的错误信息：可能被代理、防火墙或网关拦截（%s）", e.Status, truncate(e.Detail, 120))
		}
		if e.Status == http.StatusNotFound {
			return fmt.Sprintf("AI 接口地址不存在（HTTP 404）：请检查 AI_BASE_URL（%s）", truncate(e.Detail, 120))
		}
		return fmt.Sprintf("AI 服务拒绝了请求（HTTP %d）：%s", e.Status, truncate(e.Detail, 120))
	}
	return "AI 服务出错：" + truncate(e.Detail, 120)
}

func (e *Error) deepseek() bool { return strings.Contains(strings.ToLower(e.host), "deepseek") }

// paren renders "（a：b）", "（a）", "（b）" or "".
func paren(a, b string) string {
	switch {
	case a != "" && b != "":
		return "（" + a + "：" + b + "）"
	case a != "" || b != "":
		return "（" + a + b + "）"
	}
	return ""
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// UserMessage explains any error of this package in Chinese.
func UserMessage(err error) string {
	var e *Error
	switch {
	case err == nil:
		return ""
	case errors.As(err, &e):
		return e.Message()
	case errors.Is(err, ErrDisabled):
		return "未配置 AI 服务"
	case errors.Is(err, ErrNoJSON):
		return "AI 返回的内容无法解析，请重试"
	case errors.Is(err, context.DeadlineExceeded):
		return "AI 服务响应超时，请稍后再试"
	}
	return "AI 服务暂时不可用，请稍后再试"
}
