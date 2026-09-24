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
	"unicode/utf8"

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

func validatePassword(pw string) error {
	n := utf8.RuneCountInString(pw)
	if n < 6 || n > 64 {
		return errBad("密码长度需为 6–64 位")
	}
	if len(pw) > 72 {
		return errBad("密码过长")
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

// issueTokens creates an access token and a stored refresh token.
func (h *Handler) issueTokens(c *gin.Context, u *model.User) error {
	access, err := h.tokens.IssueAccess(u.ID)
	if err != nil {
		return err
	}
	plain, hash := auth.NewRefreshToken()
	if err := h.db.WithContext(c.Request.Context()).Create(&model.RefreshToken{
		UserID: u.ID, TokenHash: hash, ExpiresAt: time.Now().Add(auth.RefreshTTL),
	}).Error; err != nil {
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
		Username string `json:"username"`
		Password string `json:"password"`
		Email    string `json:"email"`
		Nickname string `json:"nickname"`
	}
	if err := bindJSON(c, &req); err != nil {
		return err
	}
	if !h.svc.Settings.Get().RegistrationOpen {
		return errForbidden("本站暂未开放注册")
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
	ip := c.ClientIP()
	if blocked, _ := h.register.Blocked(ip); blocked {
		return errTooMany("注册过于频繁，请稍后再试")
	}
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
		Role: model.RoleUser, Status: model.UserActive, LastLoginAt: &now}
	if err := db.Create(&u).Error; err != nil {
		if errors.Is(err, gorm.ErrDuplicatedKey) {
			return errConflict("用户名或邮箱已被占用")
		}
		return err
	}
	h.register.Hit(ip)
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
	for _, lk := range []struct {
		l   *auth.Limiter
		key string
	}{{h.loginAccount, acctKey}, {h.loginIP, ip}} {
		if blocked, wait := lk.l.Blocked(lk.key); blocked {
			return errTooMany(fmt.Sprintf("登录失败次数过多，请 %d 分钟后再试", int(math.Ceil(wait.Minutes()))))
		}
	}
	db := h.db.WithContext(c.Request.Context())
	var u model.User
	q := db.Where("lower(username) = lower(?)", account)
	if strings.Contains(account, "@") {
		q = db.Where("lower(email) = lower(?) AND email <> ''", account)
	}
	if err := q.Limit(1).Find(&u).Error; err != nil {
		return err
	}
	if !auth.CheckPassword(u.PasswordHash, req.Password) {
		h.loginAccount.Hit(acctKey)
		h.loginIP.Hit(ip)
		return errUnauthorized("账号或密码错误")
	}
	h.loginAccount.Reset(acctKey)
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
	// Delete-and-return makes rotation atomic: a token can be used once.
	var userIDs []int64
	if err := db.Raw("DELETE FROM refresh_tokens WHERE token_hash = ? AND expires_at > now() RETURNING user_id",
		auth.HashToken(req.RefreshToken)).Scan(&userIDs).Error; err != nil {
		return err
	}
	if len(userIDs) == 0 {
		return errUnauthorized("登录已失效，请重新登录")
	}
	var u model.User
	if err := db.Limit(1).Find(&u, userIDs[0]).Error; err != nil {
		return err
	}
	if u.ID == 0 {
		return errUnauthorized("账号不存在")
	}
	if u.Status == model.UserBanned {
		return errForbidden("账号已被封禁")
	}
	return h.issueTokens(c, &u)
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
