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
}

// Settings caches site settings stored in the settings table.
type Settings struct {
	mu  sync.RWMutex
	cur SiteSettings
	db  *gorm.DB
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
		}
	}
	return s, nil
}

// Get returns the current settings.
func (s *Settings) Get() SiteSettings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cur
}

// Save persists settings.
func (s *Settings) Save(v SiteSettings) error {
	reg := "true"
	if !v.RegistrationOpen {
		reg = "false"
	}
	rows := []model.Setting{{Key: "site_name", Value: v.SiteName}, {Key: "announcement", Value: v.Announcement}, {Key: "registration_open", Value: reg}}
	err := s.db.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "key"}}, DoUpdates: clause.AssignmentColumns([]string{"value"})}).Create(&rows).Error
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.cur = v
	s.mu.Unlock()
	return nil
}
