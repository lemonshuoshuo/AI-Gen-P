package ai

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"
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

	model    string
	host     string
	waited   time.Duration
	reasoned bool
	err      error
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

// Message explains the failure in Chinese.
func (e *Error) Message() string {
	switch e.Kind {
	case KindAuth:
		return "AI Key 无效或没有权限"
	case KindBalance:
		return "AI 账户余额不足"
	case KindModel:
		return "模型不存在：" + e.model
	case KindRateLimit:
		return "AI 服务请求过于频繁（429），请稍后再试"
	case KindTimeout:
		return fmt.Sprintf("AI 响应超时（等待了 %d 秒），可在设置中换用更快的模型或关闭深度思考", int(math.Round(e.waited.Seconds())))
	case KindCanceled:
		return "请求已取消"
	case KindNetwork:
		return "无法连接 AI 服务：" + e.host
	case KindEmpty:
		if e.reasoned {
			return "AI 只返回了思考过程、没有给出结果（可能是输出长度不够），请重试或关闭深度思考（TRIPHUB_AI_THINKING=off）"
		}
		return "AI 返回了空内容，请重试"
	case KindBadResponse:
		return "AI 服务返回的内容格式不正确，请检查 AI_BASE_URL 是否为 OpenAI 兼容接口"
	case KindServer:
		return fmt.Sprintf("AI 服务暂时不可用（HTTP %d），请稍后再试", e.Status)
	case KindRequest:
		return fmt.Sprintf("AI 服务拒绝了请求（HTTP %d）：%s", e.Status, truncate(e.Detail, 120))
	}
	return "AI 服务出错：" + truncate(e.Detail, 120)
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
