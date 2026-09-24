package service

import (
	"sync"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"triphub/internal/model"
)

// SiteSettings are admin-editable site settings.
type SiteSettings struct {
	SiteName         string `json:"site_name"`
	Announcement     string `json:"announcement"`
	RegistrationOpen bool   `json:"registration_open"`
	ICPBeian         string `json:"icp_beian"`    // ICP 备案号, shown in the site footer
	PoliceBeian      string `json:"police_beian"` // 公安联网备案号
	TermsMD          string `json:"terms_md"`     // 用户协议 (Markdown); empty = DefaultTerms
	PrivacyMD        string `json:"privacy_md"`   // 隐私政策 (Markdown); empty = DefaultPrivacy
	// SensitiveWords (屏蔽词) are rejected in text users publish; one per line.
	SensitiveWords string `json:"sensitive_words"`
	// ReviewPublicTrips holds trips non-admins make public for an admin's
	// review (status pending) before they are shown.
	ReviewPublicTrips bool `json:"review_public_trips"`
}

// Settings caches site settings stored in the settings table.
type Settings struct {
	mu    sync.RWMutex
	cur   SiteSettings
	words *wordMatcher // built from cur.SensitiveWords
	db    *gorm.DB
}

// LoadSettings reads settings, falling back to defaults.
func LoadSettings(db *gorm.DB, defaultName string) (*Settings, error) {
	s := &Settings{db: db, cur: SiteSettings{SiteName: defaultName, RegistrationOpen: true}}
	var rows []model.Setting
	if err := db.Find(&rows).Error; err != nil {
		return nil, err
	}
	for _, r := range rows {
		switch r.Key {
		case "site_name":
			if r.Value != "" {
				s.cur.SiteName = r.Value
			}
		case "announcement":
			s.cur.Announcement = r.Value
		case "registration_open":
			s.cur.RegistrationOpen = r.Value != "false"
		case "icp_beian":
			s.cur.ICPBeian = r.Value
		case "police_beian":
			s.cur.PoliceBeian = r.Value
		case "terms_md":
			s.cur.TermsMD = r.Value
		case "privacy_md":
			s.cur.PrivacyMD = r.Value
		case "sensitive_words":
			s.cur.SensitiveWords = r.Value
		case "review_public_trips":
			s.cur.ReviewPublicTrips = r.Value == "true"
		}
	}
	s.words = buildWordMatcher(s.cur.SensitiveWords)
	return s, nil
}

// Get returns the current settings.
func (s *Settings) Get() SiteSettings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cur
}

// FindWord returns the first sensitive word (as listed) contained in any of
// texts, or "".
func (s *Settings) FindWord(texts ...string) string {
	s.mu.RLock()
	m := s.words
	s.mu.RUnlock()
	for _, t := range texts {
		if w := m.find(t); w != "" {
			return w
		}
	}
	return ""
}

// Save persists settings.
func (s *Settings) Save(v SiteSettings) error {
	reg := "true"
	if !v.RegistrationOpen {
		reg = "false"
	}
	review := "false"
	if v.ReviewPublicTrips {
		review = "true"
	}
	rows := []model.Setting{{Key: "site_name", Value: v.SiteName}, {Key: "announcement", Value: v.Announcement}, {Key: "registration_open", Value: reg},
		{Key: "icp_beian", Value: v.ICPBeian}, {Key: "police_beian", Value: v.PoliceBeian},
		{Key: "terms_md", Value: v.TermsMD}, {Key: "privacy_md", Value: v.PrivacyMD},
		{Key: "sensitive_words", Value: v.SensitiveWords}, {Key: "review_public_trips", Value: review}}
	err := s.db.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "key"}}, DoUpdates: clause.AssignmentColumns([]string{"value"})}).Create(&rows).Error
	if err != nil {
		return err
	}
	words := buildWordMatcher(v.SensitiveWords)
	s.mu.Lock()
	s.cur, s.words = v, words
	s.mu.Unlock()
	return nil
}
