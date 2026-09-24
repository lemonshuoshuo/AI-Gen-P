// Package model defines the GORM database models.
package model

import "time"

// Enumerations used across the application.
const (
	RoleUser  = "user"
	RoleAdmin = "admin"

	UserActive = "active"
	UserBanned = "banned"

	PhasePlanning = "planning"
	PhaseOngoing  = "ongoing"
	PhaseFinished = "finished"

	VisPrivate  = "private"
	VisUnlisted = "unlisted"
	VisPublic   = "public"

	TripNormal = "normal"
	TripHidden = "hidden"

	MemberOwner    = "owner"
	MemberEditor   = "editor"
	MemberAccepted = "accepted"
	MemberPending  = "pending"

	WPTodo    = "todo"
	WPVisited = "visited"
	WPSkipped = "skipped"

	VerdictRecommend = "recommend"
	VerdictNeutral   = "neutral"
	VerdictAvoid     = "avoid"

	InvitePending  = "pending"
	InviteAccepted = "accepted"
	InviteDeclined = "declined"
	InviteCanceled = "canceled"

	ReportPending  = "pending"
	ReportResolved = "resolved"
	ReportRejected = "rejected"
)

// Categories of waypoints / places.
var Categories = []string{"scenic", "food", "hotel", "shopping", "transport", "entertainment", "other"}

// User is a registered account.
type User struct {
	ID           int64  `gorm:"primaryKey"`
	Username     string `gorm:"size:32;not null"`
	Email        string `gorm:"size:128;not null;default:''"`
	Nickname     string `gorm:"size:64;not null;default:''"`
	Bio          string `gorm:"size:1000;not null;default:''"`
	AvatarURL    string `gorm:"size:500;not null;default:''"`
	PasswordHash string `gorm:"size:100;not null"`
	Role         string `gorm:"size:16;not null;default:'user';index"`
	Status       string `gorm:"size:16;not null;default:'active';index"`
	Exp          int    `gorm:"not null;default:0"`
	StorageUsed  int64  `gorm:"not null;default:0"`
	LastLoginAt  *time.Time
	CreatedAt    time.Time `gorm:"index"`
	UpdatedAt    time.Time
}

// IsAdmin reports whether the user has the admin role.
func (u *User) IsAdmin() bool { return u != nil && u.Role == RoleAdmin }

// RefreshToken stores the SHA-256 hash of an issued refresh token.
type RefreshToken struct {
	ID        int64     `gorm:"primaryKey"`
	UserID    int64     `gorm:"not null;index"`
	TokenHash string    `gorm:"size:64;not null;uniqueIndex"`
	ExpiresAt time.Time `gorm:"not null;index"`
	CreatedAt time.Time
}

// Trip is a journey (plan, ongoing trip or finished journal).
type Trip struct {
	ID              int64      `gorm:"primaryKey"`
	OwnerID         int64      `gorm:"not null;index"`
	Title           string     `gorm:"size:200;not null"`
	Summary         string     `gorm:"type:text;not null;default:''"`
	Content         string     `gorm:"type:text;not null;default:''"`
	CoverURL        string     `gorm:"size:500;not null;default:''"`
	AutoCoverURL    string     `gorm:"size:500;not null;default:''"`
	Phase           string     `gorm:"size:16;not null;default:'planning';index"`
	Visibility      string     `gorm:"size:16;not null;default:'private';index:idx_trips_listing,priority:1"`
	Status          string     `gorm:"size:16;not null;default:'normal';index:idx_trips_listing,priority:2"`
	StartDate       *time.Time `gorm:"type:date"`
	EndDate         *time.Time `gorm:"type:date"`
	Days            int        `gorm:"not null;default:0"`
	DistanceKm      float64    `gorm:"not null;default:0"`
	Cities          []string   `gorm:"serializer:json;type:jsonb;not null;default:'[]'"`
	Provinces       []string   `gorm:"serializer:json;type:jsonb;not null;default:'[]'"`
	Tags            []string   `gorm:"serializer:json;type:jsonb;not null;default:'[]'"`
	WaypointCount   int        `gorm:"not null;default:0"`
	PlannedCount    int        `gorm:"not null;default:0"`
	VisitedCount    int        `gorm:"not null;default:0"`
	PhotoCount      int        `gorm:"not null;default:0"`
	LikeCount       int        `gorm:"not null;default:0"`
	CommentCount    int        `gorm:"not null;default:0"`
	ForkCount       int        `gorm:"not null;default:0"`
	FavCount        int        `gorm:"not null;default:0"`
	ViewCount       int        `gorm:"not null;default:0"`
	TrackPointCount int        `gorm:"not null;default:0"`
	TrackDistanceKm float64    `gorm:"not null;default:0"`
	Featured        bool       `gorm:"not null;default:false"`
	FeaturedAt      *time.Time
	ForkedFromID    *int64     `gorm:"index"`
	ShareCode       string     `gorm:"size:16;not null;uniqueIndex"`
	PublishedAt     *time.Time `gorm:"index:idx_trips_listing,priority:3"`
	CreatedAt       time.Time  `gorm:"index"`
	UpdatedAt       time.Time
}

// TripMember links users to trips (the owner has a row too).
type TripMember struct {
	ID          int64  `gorm:"primaryKey"`
	TripID      int64  `gorm:"not null;uniqueIndex:idx_trip_member,priority:1"`
	UserID      int64  `gorm:"not null;uniqueIndex:idx_trip_member,priority:2;index"`
	Role        string `gorm:"size:16;not null"`
	Status      string `gorm:"size:16;not null"`
	InvitedByID int64  `gorm:"not null;default:0"`
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// Waypoint is a stop on a trip, either planned or actually visited.
type Waypoint struct {
	ID           int64  `gorm:"primaryKey"`
	TripID       int64  `gorm:"not null;index:idx_wp_trip_seq,priority:1"`
	Seq          int    `gorm:"not null;index:idx_wp_trip_seq,priority:2"`
	Day          int    `gorm:"not null;default:0"`
	Planned      bool   `gorm:"not null"`
	Status       string `gorm:"size:16;not null"`
	PlannedAt    *time.Time
	ArrivedAt    *time.Time
	Name         string  `gorm:"size:200;not null"`
	Address      string  `gorm:"size:300;not null;default:''"`
	Province     string  `gorm:"size:64;not null;default:''"`
	ProvinceCode string  `gorm:"size:12;not null;default:''"`
	City         string  `gorm:"size:64;not null;default:''"`
	CityCode     string  `gorm:"size:12;not null;default:''"`
	District     string  `gorm:"size:64;not null;default:''"`
	Lng          float64 `gorm:"not null"`
	Lat          float64 `gorm:"not null"`
	Category     string  `gorm:"size:32;not null;default:'other'"`
	Note         string  `gorm:"type:text;not null;default:''"`
	Verdict      string  `gorm:"size:16;not null;default:''"`
	Rating       int     `gorm:"not null;default:0"`
	Cost         float64 `gorm:"not null;default:0"`
	AmapID       string  `gorm:"size:64;not null;default:''"`
	PlaceID      *int64  `gorm:"index"`
	AutoNamed    bool    `gorm:"not null"`
	CreatedByID  int64   `gorm:"not null;default:0"`
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// Photo is an uploaded image belonging to a trip.
type Photo struct {
	ID         int64  `gorm:"primaryKey"`
	TripID     int64  `gorm:"not null;index"`
	UserID     int64  `gorm:"not null;index"`
	WaypointID *int64 `gorm:"index"`
	Path       string `gorm:"size:300;not null"`
	ThumbPath  string `gorm:"size:300;not null"`
	Width      int    `gorm:"not null"`
	Height     int    `gorm:"not null"`
	Size       int64  `gorm:"not null"`
	TakenAt    *time.Time
	Lng        *float64
	Lat        *float64
	Caption    string `gorm:"size:1000;not null;default:''"`
	CreatedAt  time.Time
}

// TrackPoint is a raw GPS sample (stored in GCJ-02).
type TrackPoint struct {
	ID         int64     `gorm:"primaryKey"`
	TripID     int64     `gorm:"not null;index:idx_track_trip_time,priority:1;uniqueIndex:idx_track_unique,priority:1"`
	UserID     int64     `gorm:"not null;uniqueIndex:idx_track_unique,priority:2"`
	Segment    int       `gorm:"not null;uniqueIndex:idx_track_unique,priority:3"`
	Lng        float64   `gorm:"not null"`
	Lat        float64   `gorm:"not null"`
	Alt        float64   `gorm:"not null;default:0"`
	Acc        float64   `gorm:"not null;default:0"`
	Speed      float64   `gorm:"not null;default:0"`
	RecordedAt time.Time `gorm:"not null;index:idx_track_trip_time,priority:2;uniqueIndex:idx_track_unique,priority:4"`
}

// Place is a POI aggregated across users' waypoints.
type Place struct {
	ID             int64   `gorm:"primaryKey"`
	AmapID         string  `gorm:"size:64;not null;default:''"`
	Name           string  `gorm:"size:200;not null;index"`
	Address        string  `gorm:"size:300;not null;default:''"`
	Province       string  `gorm:"size:64;not null;default:''"`
	City           string  `gorm:"size:64;not null;default:'';index"`
	District       string  `gorm:"size:64;not null;default:''"`
	Lng            float64 `gorm:"not null;index:idx_place_geo,priority:1"`
	Lat            float64 `gorm:"not null;index:idx_place_geo,priority:2"`
	Category       string  `gorm:"size:32;not null;default:'other'"`
	Tel            string  `gorm:"size:100;not null;default:''"`
	CheckinCount   int     `gorm:"not null;default:0;index"`
	RatingAvg      float64 `gorm:"not null;default:0"`
	RatingCount    int     `gorm:"not null;default:0"`
	RecommendCount int     `gorm:"not null;default:0"`
	NeutralCount   int     `gorm:"not null;default:0"`
	AvoidCount     int     `gorm:"not null;default:0"`
	AvgCost        float64 `gorm:"not null;default:0"`
	CommentCount   int     `gorm:"not null;default:0"`
	CoverURL       string  `gorm:"size:500;not null;default:''"`
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// Comment on a trip (optionally a waypoint) or on a place.
type Comment struct {
	ID            int64  `gorm:"primaryKey"`
	TripID        *int64 `gorm:"index"`
	PlaceID       *int64 `gorm:"index"`
	WaypointID    *int64 `gorm:"index"`
	ParentID      *int64 `gorm:"index"`
	UserID        int64  `gorm:"not null;index"`
	ReplyToUserID *int64
	Content       string    `gorm:"type:text;not null"`
	Deleted       bool      `gorm:"not null"`
	CreatedAt     time.Time `gorm:"index"`
	UpdatedAt     time.Time
}

// Like of a trip.
type Like struct {
	UserID    int64 `gorm:"primaryKey;autoIncrement:false"`
	TripID    int64 `gorm:"primaryKey;autoIncrement:false;index"`
	CreatedAt time.Time
}

// Favorite (bookmark) of a trip.
type Favorite struct {
	UserID    int64 `gorm:"primaryKey;autoIncrement:false"`
	TripID    int64 `gorm:"primaryKey;autoIncrement:false;index"`
	CreatedAt time.Time
}

// Follow relation.
type Follow struct {
	FollowerID int64 `gorm:"primaryKey;autoIncrement:false"`
	FolloweeID int64 `gorm:"primaryKey;autoIncrement:false;index"`
	CreatedAt  time.Time
}

// Partnership binds two users as a couple (UserA < UserB).
type Partnership struct {
	ID      int64      `gorm:"primaryKey"`
	UserA   int64      `gorm:"not null;uniqueIndex"`
	UserB   int64      `gorm:"not null;uniqueIndex"`
	Since   *time.Time `gorm:"type:date"`
	Title   string     `gorm:"size:100;not null;default:''"`
	BoundAt time.Time  `gorm:"not null"`
}

// PartnerInvite is a pending/processed couple-binding request.
type PartnerInvite struct {
	ID        int64  `gorm:"primaryKey"`
	FromID    int64  `gorm:"not null;index"`
	ToID      int64  `gorm:"not null;index"`
	Message   string `gorm:"size:500;not null;default:''"`
	Status    string `gorm:"size:16;not null;index"`
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Notification delivered to a user.
type Notification struct {
	ID        int64  `gorm:"primaryKey"`
	UserID    int64  `gorm:"not null;index:idx_notif_user,priority:1"`
	Type      string `gorm:"size:32;not null"`
	ActorID   *int64
	TripID    *int64 `gorm:"index"`
	PlaceID   *int64
	CommentID *int64
	Content   string    `gorm:"size:500;not null;default:''"`
	Read      bool      `gorm:"not null;index:idx_notif_user,priority:2"`
	CreatedAt time.Time `gorm:"index"`
}

// Report of abusive content.
type Report struct {
	ID          int64  `gorm:"primaryKey"`
	ReporterID  int64  `gorm:"not null;index"`
	TargetType  string `gorm:"size:16;not null"`
	TargetID    int64  `gorm:"not null"`
	Reason      string `gorm:"size:1000;not null"`
	Status      string `gorm:"size:16;not null;index"`
	Note        string `gorm:"size:1000;not null;default:''"`
	HandledByID *int64
	HandledAt   *time.Time
	CreatedAt   time.Time
}

// ExpLog records experience awards; Key makes awards idempotent.
type ExpLog struct {
	ID        int64  `gorm:"primaryKey"`
	UserID    int64  `gorm:"not null;index"`
	Key       string `gorm:"size:128;not null;uniqueIndex"`
	Amount    int    `gorm:"not null"`
	Reason    string `gorm:"size:64;not null"`
	CreatedAt time.Time
}

// Setting is a key/value site setting.
type Setting struct {
	Key   string `gorm:"primaryKey;size:64"`
	Value string `gorm:"type:text;not null"`
}

// All lists every model for AutoMigrate.
func All() []any {
	return []any{
		&User{}, &RefreshToken{}, &Trip{}, &TripMember{}, &Waypoint{}, &Photo{}, &TrackPoint{},
		&Place{}, &Comment{}, &Like{}, &Favorite{}, &Follow{}, &Partnership{}, &PartnerInvite{},
		&Notification{}, &Report{}, &ExpLog{}, &Setting{},
	}
}
