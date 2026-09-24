package handler

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// bindJSON decodes the JSON body into dst. An empty body leaves dst untouched.
func bindJSON(c *gin.Context, dst any) error {
	if c.Request.Body == nil {
		return nil
	}
	dec := json.NewDecoder(c.Request.Body)
	if err := dec.Decode(dst); err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return errTooLarge("请求内容过大")
		}
		var te *json.UnmarshalTypeError
		if errors.As(err, &te) && te.Field != "" {
			return errBad("参数 " + te.Field + " 类型错误")
		}
		return errBad("请求数据格式错误")
	}
	return nil
}

// Opt distinguishes an absent JSON field from an explicit null.
type Opt[T any] struct {
	Set  bool
	Null bool
	V    T
}

// UnmarshalJSON implements json.Unmarshaler.
func (o *Opt[T]) UnmarshalJSON(b []byte) error {
	o.Set = true
	if string(b) == "null" {
		o.Null = true
		return nil
	}
	return json.Unmarshal(b, &o.V)
}

// paging holds pagination parameters.
type paging struct {
	Page, Size int
}

func (p paging) Offset() int { return (p.Page - 1) * p.Size }

func pageParams(c *gin.Context) paging {
	page, _ := strconv.Atoi(c.Query("page"))
	size, _ := strconv.Atoi(c.Query("page_size"))
	if page < 1 {
		page = 1
	}
	if page > 10000 {
		page = 10000
	}
	if size < 1 {
		size = 20
	}
	if size > 50 {
		size = 50
	}
	return paging{page, size}
}

// pageResult is the paginated response envelope.
type pageResult struct {
	Items    any   `json:"items"`
	Total    int64 `json:"total"`
	Page     int   `json:"page"`
	PageSize int   `json:"page_size"`
}

func newPage(items any, total int64, p paging) pageResult {
	return pageResult{Items: items, Total: total, Page: p.Page, PageSize: p.Size}
}

// paginate counts and fetches one page of q into dest.
func paginate(q *gorm.DB, p paging, order string, dest any) (int64, error) {
	q = q.Session(&gorm.Session{})
	var total int64
	if err := q.Count(&total).Error; err != nil {
		return 0, err
	}
	if total == 0 {
		return 0, nil
	}
	err := q.Order(order).Offset(p.Offset()).Limit(p.Size).Find(dest).Error
	return total, err
}

func idParam(c *gin.Context, name string) (int64, error) {
	id, err := strconv.ParseInt(c.Param(name), 10, 64)
	if err != nil || id <= 0 {
		return 0, errNotFound("资源不存在")
	}
	return id, nil
}

func queryInt64(c *gin.Context, name string) (int64, bool) {
	v := c.Query(name)
	if v == "" {
		return 0, false
	}
	id, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return 0, false
	}
	return id, true
}

func queryFloat(c *gin.Context, name string) (float64, bool) {
	v := strings.TrimSpace(c.Query(name))
	if v == "" {
		return 0, false
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return 0, false
	}
	return f, true
}

func queryBool(c *gin.Context, name string) bool {
	switch strings.ToLower(c.Query(name)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// coordType validates a coord_type value, returning def when empty.
func coordType(v, def string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "":
		return def, nil
	case "gcj02", "gcj-02", "gcj":
		return "gcj02", nil
	case "wgs84", "wgs-84", "wgs", "gps":
		return "wgs84", nil
	}
	return "", errBad("coord_type 只能是 gcj02 或 wgs84")
}

// parseDate parses YYYY-MM-DD as UTC midnight; "" yields nil.
func parseDate(s, field string) (*time.Time, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, nil
	}
	if len(s) > 10 {
		s = s[:10] // tolerate full timestamps
	}
	t, err := time.Parse("2006-01-02", s)
	if err != nil || t.Year() < 1900 || t.Year() > 2200 {
		return nil, errBad(field + " 日期格式应为 YYYY-MM-DD")
	}
	return &t, nil
}

var timeLayouts = []string{
	time.RFC3339Nano,
	"2006-01-02T15:04:05",
	"2006-01-02T15:04",
	"2006-01-02 15:04:05",
	"2006-01-02 15:04",
	"2006-01-02",
}

// parseTime parses RFC3339 (or a zone-less local time interpreted in loc).
func parseTime(s, field string, loc *time.Location) (*time.Time, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, nil
	}
	for i, layout := range timeLayouts {
		var t time.Time
		var err error
		if i == 0 {
			t, err = time.Parse(layout, s)
		} else {
			t, err = time.ParseInLocation(layout, s, loc)
		}
		if err == nil {
			if t.Year() < 1900 || t.Year() > 2200 {
				break
			}
			return &t, nil
		}
	}
	return nil, errBad(field + " 时间格式错误，应为 RFC3339")
}

// clean trims a string and validates its rune length.
func clean(s, field string, max int, required bool) (string, error) {
	s = strings.TrimSpace(strings.ToValidUTF8(s, ""))
	if required && s == "" {
		return "", errBad(field + "不能为空")
	}
	if utf8.RuneCountInString(s) > max {
		return "", errBad(field + "不能超过 " + strconv.Itoa(max) + " 个字")
	}
	return s, nil
}

// validURL accepts "" and site-relative /uploads/ paths, i.e. images uploaded
// to this site: an external image would bypass upload checks and moderation
// (and could track viewers).
func validURL(s, field string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" || (strings.HasPrefix(s, "/uploads/") && len(s) <= 500 && !strings.Contains(s, "..") && !strings.ContainsAny(s, " \"'<>\\")) {
		return s, nil
	}
	return "", errBad(field + " 无效，请使用本站上传的图片")
}

// screen rejects text that contains one of the admin's sensitive words
// (屏蔽词, see service.Settings.FindWord). Admins are not screened.
func (h *Handler) screen(c *gin.Context, texts ...string) error {
	if currentUser(c).IsAdmin() {
		return nil
	}
	if w := h.svc.Settings.FindWord(texts...); w != "" {
		return errBad("内容包含不允许发布的词语「" + w + "」，请修改后再提交")
	}
	return nil
}

func escapeLike(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + r.Replace(s) + "%"
}
