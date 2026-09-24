package service

import (
	"fmt"
	"strconv"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"triphub/internal/model"
)

// Level is a user level definition.
type Level struct {
	Level   int    `json:"level"`
	Name    string `json:"name"`
	MinExp  int    `json:"min_exp"`
	QuotaMB int    `json:"quota_mb"`
}

// Levels is the level table (see API.md 用户等级).
var Levels = []Level{
	{1, "新手旅人", 0, 300},
	{2, "背包客", 50, 1024},
	{3, "探路者", 200, 2048},
	{4, "旅行家", 600, 5120},
	{5, "环游者", 1500, 10240},
	{6, "传奇旅人", 4000, 20480},
}

// LevelFor returns the level for an exp value and the exp needed for the
// next level (nil at max level).
func LevelFor(exp int) (Level, *int) {
	cur := Levels[0]
	var next *int
	for i, l := range Levels {
		if exp >= l.MinExp {
			cur = l
			next = nil
			if i+1 < len(Levels) {
				n := Levels[i+1].MinExp
				next = &n
			}
		}
	}
	return cur, next
}

// QuotaBytes returns the storage quota of a user in bytes (0 = unlimited for admins).
func QuotaBytes(u *model.User) int64 {
	if u.IsAdmin() {
		return 0
	}
	l, _ := LevelFor(u.Exp)
	return int64(l.QuotaMB) << 20
}

// Experience rewards (API.md 用户等级).
const (
	ExpCreateTrip  = 5
	ExpFirstPublic = 20
	ExpWaypoint    = 1
	ExpPhoto       = 1
	ExpComment     = 1
	ExpLiked       = 2
	ExpFavorited   = 2
	ExpCommented   = 1
	ExpForked      = 5
	ExpFollowed    = 2
	ExpFeatured    = 50
)

// ExpKey builds an idempotency key such as "liked:12:7".
func ExpKey(kind string, ids ...int64) string {
	k := kind
	for _, id := range ids {
		k += ":" + strconv.FormatInt(id, 10)
	}
	return k
}

// AwardExp grants experience once per key. On level-up a system notification is sent.
func (s *Service) AwardExp(tx *gorm.DB, userID int64, key string, amount int, reason string) error {
	if userID == 0 || amount == 0 {
		return nil
	}
	res := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&model.ExpLog{UserID: userID, Key: key, Amount: amount, Reason: reason})
	if res.Error != nil || res.RowsAffected == 0 {
		return res.Error
	}
	var newExp int
	if err := tx.Raw("UPDATE users SET exp = exp + ? WHERE id = ? RETURNING exp", amount, userID).Scan(&newExp).Error; err != nil {
		return err
	}
	before, _ := LevelFor(newExp - amount)
	after, _ := LevelFor(newExp)
	if after.Level > before.Level {
		return s.Notify(tx, Notice{UserID: userID, Type: "system",
			Content: fmt.Sprintf("恭喜升级到 Lv%d「%s」，存储空间提升至 %s", after.Level, after.Name, formatMB(after.QuotaMB))})
	}
	return nil
}

func formatMB(mb int) string {
	if mb >= 1024 && mb%1024 == 0 {
		return fmt.Sprintf("%d GB", mb/1024)
	}
	return fmt.Sprintf("%d MB", mb)
}
