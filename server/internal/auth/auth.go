// Package auth handles password hashing, JWT access tokens, refresh tokens
// and login rate limiting.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

// AccessTTL is the lifetime of access tokens.
const AccessTTL = 2 * time.Hour

// RefreshTTL is the lifetime of refresh tokens.
const RefreshTTL = 30 * 24 * time.Hour

// dummyHash is compared against when an account does not exist so that
// login timing does not reveal whether a username exists.
var dummyHash, _ = bcrypt.GenerateFromPassword([]byte("triphub-dummy-password"), bcrypt.DefaultCost)

// Password length limits (characters), shared by registration, password
// changes, admin resets, the seeded admin and `triphub reset-password`.
const MinPasswordLen, MaxPasswordLen = 8, 64

// weakPasswords are rejected whatever their length: the placeholders of the
// example deployment configuration and the most common passwords.
var weakPasswords = map[string]bool{
	"change-me-admin-password": true, "change-me-to-a-strong-password": true,
	"12345678": true, "123456789": true, "11111111": true, "88888888": true,
	"password": true, "iloveyou": true, "woaini1314": true,
}

// ValidatePassword checks a new password against the password policy. The
// error message is user-facing.
func ValidatePassword(pw string) error {
	n := utf8.RuneCountInString(pw)
	if n < MinPasswordLen || n > MaxPasswordLen {
		return fmt.Errorf("密码长度需为 %d–%d 位", MinPasswordLen, MaxPasswordLen)
	}
	if len(pw) > 72 { // bcrypt ignores the rest
		return errors.New("密码过长")
	}
	if weakPasswords[strings.ToLower(pw)] {
		return errors.New("密码过于简单或为示例密码，请换一个")
	}
	return nil
}

// HashPassword hashes a password with bcrypt.
func HashPassword(pw string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.DefaultCost)
	return string(b), err
}

// CheckPassword compares a password with a bcrypt hash. An empty hash burns
// the same CPU time and returns false.
func CheckPassword(hash, pw string) bool {
	if hash == "" {
		_ = bcrypt.CompareHashAndPassword(dummyHash, []byte(pw))
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pw)) == nil
}

// Tokens issues and verifies JWT access tokens.
type Tokens struct {
	secret []byte
}

// NewTokens creates a token manager with an HMAC secret.
func NewTokens(secret string) *Tokens { return &Tokens{secret: []byte(secret)} }

// ErrInvalidToken is returned for malformed or expired tokens.
var ErrInvalidToken = errors.New("invalid token")

// IssueAccess returns a signed access token for a user. sessionID is the ID
// of the refresh token issued alongside (carried as the JWT ID) so that
// "other sessions" can be told apart from the current one and an access
// token stops working when its session is revoked.
func (t *Tokens) IssueAccess(userID, sessionID int64) (string, error) {
	now := time.Now()
	claims := jwt.RegisteredClaims{
		Issuer:    "triphub",
		Subject:   strconv.FormatInt(userID, 10),
		ID:        strconv.FormatInt(sessionID, 10),
		IssuedAt:  jwt.NewNumericDate(now),
		ExpiresAt: jwt.NewNumericDate(now.Add(AccessTTL)),
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(t.secret)
}

// ParseAccess validates an access token and returns the user and session IDs.
func (t *Tokens) ParseAccess(token string) (userID, sessionID int64, err error) {
	var claims jwt.RegisteredClaims
	_, err = jwt.ParseWithClaims(token, &claims, func(*jwt.Token) (any, error) { return t.secret, nil },
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}), jwt.WithIssuer("triphub"), jwt.WithExpirationRequired())
	if err != nil {
		return 0, 0, ErrInvalidToken
	}
	userID, err = strconv.ParseInt(claims.Subject, 10, 64)
	if err != nil || userID <= 0 {
		return 0, 0, ErrInvalidToken
	}
	sessionID, _ = strconv.ParseInt(claims.ID, 10, 64)
	return userID, sessionID, nil
}

// NewRefreshToken returns a random opaque token and its SHA-256 hash.
func NewRefreshToken() (plain, hash string) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	plain = base64.RawURLEncoding.EncodeToString(b)
	return plain, HashToken(plain)
}

// HashToken hashes a refresh token for storage / lookup.
func HashToken(plain string) string {
	sum := sha256.Sum256([]byte(plain))
	return hex.EncodeToString(sum[:])
}

const base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// RandomBase62 returns n random base62 characters.
func RandomBase62(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	out := make([]byte, n)
	for i, v := range b {
		// Re-draw bytes >= 248 (= 62*4) so that v%62 is uniform.
		for v >= 248 {
			var one [1]byte
			if _, err := rand.Read(one[:]); err != nil {
				panic(err)
			}
			v = one[0]
		}
		out[i] = base62[int(v)%62]
	}
	return string(out)
}
