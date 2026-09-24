package handler

import (
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/mail"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"triphub/internal/auth"
	"triphub/internal/model"
)

var usernameRe = regexp.MustCompile(`^[A-Za-z0-9_]{3,20}$`)

var reservedNames = map[string]bool{
	"admin": true, "administrator": true, "root": true, "system": true, "triphub": true,
	"api": true, "me": true, "null": true, "undefined": true, "support": true,
}

// validatePassword applies the password policy (auth.ValidatePassword) to a new password.
func validatePassword(pw string) error {
	if err := auth.ValidatePassword(pw); err != nil {
		return errBad(err.Error())
	}
	return nil
}

func normalizeEmail(email string) (string, error) {
	email = strings.TrimSpace(email)
	if email == "" {
		return "", nil
	}
	addr, err := mail.ParseAddress(email)
	if err != nil || addr.Address != email || len(email) > 100 || !strings.Contains(email, ".") {
		return "", errBad("邮箱格式不正确")
	}
	return email, nil
}

type authResult struct {
	User         *MeDTO `json:"user"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
}

// issueTokens starts a session: a stored refresh token (its row ID is the
// session ID) and an access token.
func (h *Handler) issueTokens(c *gin.Context, u *model.User) error {
	plain, hash := auth.NewRefreshToken()
	rt := model.RefreshToken{UserID: u.ID, TokenHash: hash, ExpiresAt: time.Now().Add(auth.RefreshTTL)}
	if err := h.db.WithContext(c.Request.Context()).Create(&rt).Error; err != nil {
		return err
	}
	return h.respondTokens(c, u, rt.ID, plain)
}

// respondTokens responds with a new access token of session sid and the
// session's refresh token plain.
func (h *Handler) respondTokens(c *gin.Context, u *model.User, sid int64, plain string) error {
	access, err := h.tokens.IssueAccess(u.ID, sid)
	if err != nil {
		return err
	}
	me, err := h.meDTO(c.Request.Context(), u)
	if err != nil {
		return err
	}
	c.JSON(http.StatusOK, authResult{User: me, AccessToken: access, RefreshToken: plain, ExpiresIn: int(auth.AccessTTL.Seconds())})
	return nil
}

func (h *Handler) registerUser(c *gin.Context) error {
	var req struct {
		Username   string `json:"username"`
		Password   string `json:"password"`
		Email      string `json:"email"`
		Nickname   string `json:"nickname"`
		AgreeTerms bool   `json:"agree_terms"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	if !h.svc.Settings.Get().RegistrationOpen {
		return errForbidden("本站暂未开放注册")
	}
	if !req.AgreeTerms {
		return errBad("请先阅读并同意用户协议和隐私政策")
	}
	req.Username = strings.TrimSpace(req.Username)
	if !usernameRe.MatchString(req.Username) {
		return errBad("用户名需为 3–20 位字母、数字或下划线")
	}
	if reservedNames[strings.ToLower(req.Username)] {
		return errBad("该用户名不可用")
	}
	if err := validatePassword(req.Password); err != nil {
		return err
	}
	email, err := normalizeEmail(req.Email)
	if err != nil {
		return err
	}
	nickname, err := clean(req.Nickname, "昵称", 20, false)
	if err != nil {
		return err
	}
	if nickname == "" {
		nickname = req.Username
	}
	if err := h.screen(c, req.Username, nickname); err != nil {
		return err
	}
	ip := c.ClientIP()
	// Reserve a slot up front so parallel requests cannot overshoot the
	// limit; only accounts actually created keep it.
	if ok, _ := h.register.Acquire(ip); !ok {
		return errTooMany("注册过于频繁，请稍后再试")
	}
	created := false
	defer func() {
		if !created {
			h.register.Release(ip)
		}
	}()
	db := h.db.WithContext(c.Request.Context())
	var n int64
	if err := db.Model(&model.User{}).Where("lower(username) = lower(?)", req.Username).Count(&n).Error; err != nil {
		return err
	}
	if n > 0 {
		return errConflict("用户名已被占用")
	}
	if email != "" {
		if err := db.Model(&model.User{}).Where("lower(email) = lower(?)", email).Count(&n).Error; err != nil {
			return err
		}
		if n > 0 {
			return errConflict("邮箱已被注册")
		}
	}
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		return err
	}
	now := time.Now()
	u := model.User{Username: req.Username, Email: email, Nickname: nickname, PasswordHash: hash,
		Role: model.RoleUser, Status: model.UserActive, LastLoginAt: &now, TermsAgreedAt: &now}
	if err := db.Create(&u).Error; err != nil {
		if errors.Is(err, gorm.ErrDuplicatedKey) {
			return errConflict("用户名或邮箱已被占用")
		}
		return err
	}
	created = true
	return h.issueTokens(c, &u)
}

func (h *Handler) login(c *gin.Context) error {
	var req struct {
		Account  string `json:"account"`
		Password string `json:"password"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	account := strings.TrimSpace(req.Account)
	if account == "" || req.Password == "" {
		return errBad("请输入账号和密码")
	}
	ip := c.ClientIP()
	acctKey := ip + "|" + strings.ToLower(account)
	tooMany := func(wait time.Duration) error {
		return errTooMany(fmt.Sprintf("登录失败次数过多，请 %d 分钟后再试", int(math.Ceil(wait.Minutes()))))
	}
	// Count the attempt as a failure before the slow bcrypt check, so parallel
	// guesses cannot all pass the limit check; a successful login gives it back.
	if ok, wait := h.loginAccount.Acquire(acctKey); !ok {
		return tooMany(wait)
	}
	if ok, wait := h.loginIP.Acquire(ip); !ok {
		h.loginAccount.Release(acctKey)
		return tooMany(wait)
	}
	db := h.db.WithContext(c.Request.Context())
	var u model.User
	q := db.Where("lower(username) = lower(?)", account)
	if strings.Contains(account, "@") {
		q = db.Where("lower(email) = lower(?) AND email <> ''", account)
	}
	if err := q.Limit(1).Find(&u).Error; err != nil {
		h.loginAccount.Release(acctKey)
		h.loginIP.Release(ip)
		return err
	}
	if !auth.CheckPassword(u.PasswordHash, req.Password) {
		return errUnauthorized("账号或密码错误") // the reserved slots record the failure
	}
	h.loginAccount.Reset(acctKey)
	h.loginIP.Release(ip) // only failures count against the IP
	if u.Status == model.UserBanned {
		return errForbidden("账号已被封禁")
	}
	now := time.Now()
	db.Model(&u).UpdateColumn("last_login_at", now)
	u.LastLoginAt = &now
	return h.issueTokens(c, &u)
}

func (h *Handler) refresh(c *gin.Context) error {
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	if req.RefreshToken == "" {
		return errUnauthorized("缺少 refresh_token")
	}
	db := h.db.WithContext(c.Request.Context())
	// The conditional UPDATE is atomic, so a refresh token can be used once.
	// The row is rotated in place: its ID is the session ID carried by access
	// tokens, so those issued before stay valid until they expire.
	plain, hash := auth.NewRefreshToken()
	var rows []struct{ ID, UserID int64 }
	if err := db.Raw("UPDATE refresh_tokens SET token_hash = ?, expires_at = ? WHERE token_hash = ? AND expires_at > now() RETURNING id, user_id",
		hash, time.Now().Add(auth.RefreshTTL), auth.HashToken(req.RefreshToken)).Scan(&rows).Error; err != nil {
		return err
	}
	if len(rows) == 0 {
		return errUnauthorized("登录已失效，请重新登录")
	}
	var u model.User
	if err := db.Limit(1).Find(&u, rows[0].UserID).Error; err != nil {
		return err
	}
	if u.ID == 0 || u.Status == model.UserDeleted || u.Status == model.UserBanned {
		if err := db.Delete(&model.RefreshToken{}, rows[0].ID).Error; err != nil {
			return err
		}
		if u.Status == model.UserBanned {
			return errForbidden("账号已被封禁")
		}
		return errUnauthorized("账号不存在")
	}
	return h.respondTokens(c, &u, rows[0].ID, plain)
}

func (h *Handler) logout(c *gin.Context) error {
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	if req.RefreshToken != "" {
		if err := h.db.WithContext(c.Request.Context()).Where("token_hash = ?", auth.HashToken(req.RefreshToken)).
			Delete(&model.RefreshToken{}).Error; err != nil {
			return err
		}
	}
	c.JSON(http.StatusOK, gin.H{})
	return nil
}
