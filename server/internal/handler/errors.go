package handler

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// apiError is an error with an HTTP status and a user-facing Chinese message.
type apiError struct {
	Status  int
	Code    string
	Message string
}

func (e *apiError) Error() string { return e.Code + ": " + e.Message }

func errBad(msg string) error { return &apiError{http.StatusBadRequest, "bad_request", msg} }
func errUnauthorized(msg string) error {
	return &apiError{http.StatusUnauthorized, "unauthorized", msg}
}
func errForbidden(msg string) error { return &apiError{http.StatusForbidden, "forbidden", msg} }
func errNotFound(msg string) error  { return &apiError{http.StatusNotFound, "not_found", msg} }
func errConflict(msg string) error  { return &apiError{http.StatusConflict, "conflict", msg} }
func errTooLarge(msg string) error {
	return &apiError{http.StatusRequestEntityTooLarge, "payload_too_large", msg}
}
func errTooMany(msg string) error {
	return &apiError{http.StatusTooManyRequests, "too_many_requests", msg}
}

var (
	errTripNotFound  = errNotFound("旅程不存在或无权查看")
	errNotMember     = errForbidden("只有旅程成员可以操作")
	errNotOwner      = errForbidden("只有旅程作者可以操作")
	errLoginRequired = errUnauthorized("请先登录")
)

func abortJSON(c *gin.Context, status int, code, msg string) {
	c.AbortWithStatusJSON(status, gin.H{"error": gin.H{"code": code, "message": msg}})
}

// writeError converts any error into the unified error response.
func writeError(c *gin.Context, err error) {
	var ae *apiError
	var mbe *http.MaxBytesError
	switch {
	case errors.As(err, &ae):
		abortJSON(c, ae.Status, ae.Code, ae.Message)
	case errors.Is(err, gorm.ErrRecordNotFound):
		abortJSON(c, http.StatusNotFound, "not_found", "资源不存在")
	case errors.As(err, &mbe):
		abortJSON(c, http.StatusRequestEntityTooLarge, "payload_too_large", "请求内容过大")
	case errors.Is(err, gorm.ErrDuplicatedKey):
		abortJSON(c, http.StatusConflict, "conflict", "数据重复，请刷新后重试")
	default:
		slog.Error("request failed", "method", c.Request.Method, "path", c.Request.URL.Path, "err", err)
		abortJSON(c, http.StatusInternalServerError, "internal", "服务器内部错误，请稍后重试")
	}
}

// handlerFunc is a gin handler that returns an error.
type handlerFunc func(c *gin.Context) error

// w adapts a handlerFunc to gin.
func w(fn handlerFunc) gin.HandlerFunc {
	return func(c *gin.Context) {
		if err := fn(c); err != nil {
			writeError(c, err)
		}
	}
}
