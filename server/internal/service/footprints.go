package service

import (
	"sort"
	"time"

	"gorm.io/gorm"

	"triphub/internal/geo"
	"triphub/internal/model"
)

// MaxFootprintPoints caps the number of points returned in footprints.
const MaxFootprintPoints = 5000

// Footprints is the aggregated "where I have been" view.
type Footprints struct {
	Stats     FootStats      `json:"stats"`
	Points    []FootPoint    `json:"points"`
	Provinces []FootProvince `json:"provinces"`
	Cities    []FootCity     `json:"cities"`
	Trips     []FootTrip     `json:"trips"`
}

// FootStats summarises footprints.
type FootStats struct {
	Trips      int     `json:"trips"`
	Waypoints  int     `json:"waypoints"`
	Photos     int     `json:"photos"`
	DistanceKm float64 `json:"distance_km"`
	Days       int     `json:"days"`
	Cities     int     `json:"cities"`
	Provinces  int     `json:"provinces"`
	FirstDate  *string `json:"first_date"`
	LastDate   *string `json:"last_date"`
}

// FootPoint is a visited waypoint.
type FootPoint struct {
	Lng       float64 `json:"lng"`
	Lat       float64 `json:"lat"`
	Name      string  `json:"name"`
	City      string  `json:"city"`
	Province  string  `json:"province"`
	Category  string  `json:"category"`
	Verdict   string  `json:"verdict"`
	TripID    int64   `json:"trip_id"`
	TripTitle string  `json:"trip_title"`
	Date      *string `json:"date"`
}

// FootProvince counts visited waypoints per province.
type FootProvince struct {
	Code  string `json:"code"`
	Name  string `json:"name"`
	Count int    `json:"count"`
}

// FootCity counts visited waypoints per city with their mean position.
type FootCity struct {
	Code     string  `json:"code"`
	Name     string  `json:"name"`
	Province string  `json:"province"`
	Count    int     `json:"count"`
	Lng      float64 `json:"lng"`
	Lat      float64 `json:"lat"`
}

// FootTrip is a trip in footprints with its actual path.
type FootTrip struct {
	ID         int64        `json:"id"`
	Title      string       `json:"title"`
	StartDate  *string      `json:"start_date"`
	EndDate    *string      `json:"end_date"`
	CoverURL   string       `json:"cover_url"`
	DistanceKm float64      `json:"distance_km"`
	Path       [][2]float64 `json:"path"`

	sortKey time.Time
}

// EmptyFootprints returns an empty (non-null) result.
func EmptyFootprints() *Footprints {
	return &Footprints{Points: []FootPoint{}, Provinces: []FootProvince{}, Cities: []FootCity{}, Trips: []FootTrip{}}
}

// BuildFootprints aggregates visited waypoints of the trips selected by tripIDs
// (a subquery selecting trip IDs).
func (s *Service) BuildFootprints(db *gorm.DB, tripIDs *gorm.DB) (*Footprints, error) {
	out := EmptyFootprints()
	var trips []model.Trip
	if err := db.Where("id IN (?)", tripIDs).Find(&trips).Error; err != nil {
		return nil, err
	}
	if len(trips) == 0 {
		return out, nil
	}
	ids := make([]int64, len(trips))
	for i, t := range trips {
		ids[i] = t.ID
	}
	var wps []model.Waypoint
	if err := db.Where("trip_id IN ? AND status = ?", ids, model.WPVisited).Order("trip_id, seq, id").Find(&wps).Error; err != nil {
		return nil, err
	}
	byTrip := map[int64][]model.Waypoint{}
	for _, w := range wps {
		byTrip[w.TripID] = append(byTrip[w.TripID], w)
	}

	dates := map[time.Time]bool{}
	var first, last time.Time
	addDate := func(d time.Time) {
		dates[d] = true
		if first.IsZero() || d.Before(first) {
			first = d
		}
		if d.After(last) {
			last = d
		}
	}
	type cityAgg struct {
		FootCity
		sumLng, sumLat float64
	}
	provCount := map[string]*FootProvince{}
	cityCount := map[string]*cityAgg{}
	var points []FootPoint

	for _, t := range trips {
		route := ActualRoute(byTrip[t.ID])
		if len(route) == 0 && t.TrackPointCount == 0 {
			continue
		}
		out.Stats.Trips++
		out.Stats.Waypoints += len(route)
		out.Stats.Photos += t.PhotoCount
		out.Stats.DistanceKm += t.DistanceKm

		// Dates covered by this trip.
		var tripFirst time.Time
		if t.StartDate != nil && t.EndDate != nil && !t.EndDate.Before(*t.StartDate) {
			start := t.StartDate.UTC()
			for d, n := start, 0; !d.After(t.EndDate.UTC()) && n < 366; d, n = d.AddDate(0, 0, 1), n+1 {
				addDate(d)
			}
			tripFirst = start
		} else {
			if t.StartDate != nil {
				addDate(t.StartDate.UTC())
				tripFirst = t.StartDate.UTC()
			}
			for _, w := range route {
				if w.ArrivedAt != nil {
					d := DateOnly(*w.ArrivedAt, s.Loc)
					addDate(d)
					if tripFirst.IsZero() || d.Before(tripFirst) {
						tripFirst = d
					}
				}
			}
		}
		if tripFirst.IsZero() {
			tripFirst = t.CreatedAt
		}

		cover := t.CoverURL
		if cover == "" {
			cover = t.AutoCoverURL
		}
		out.Trips = append(out.Trips, FootTrip{
			ID: t.ID, Title: t.Title, StartDate: FormatDate(t.StartDate), EndDate: FormatDate(t.EndDate),
			CoverURL: cover, DistanceKm: t.DistanceKm, Path: RoutePath(route), sortKey: tripFirst,
		})

		for _, w := range route {
			points = append(points, FootPoint{
				Lng: geo.Round(w.Lng, 6), Lat: geo.Round(w.Lat, 6), Name: w.Name, City: w.City, Province: w.Province,
				Category: w.Category, Verdict: w.Verdict, TripID: t.ID, TripTitle: t.Title, Date: s.pointDate(&t, &w),
			})
			if w.ProvinceCode != "" {
				p := provCount[w.ProvinceCode]
				if p == nil {
					p = &FootProvince{Code: w.ProvinceCode, Name: w.Province}
					provCount[w.ProvinceCode] = p
				}
				p.Count++
			}
			if w.CityCode != "" {
				c := cityCount[w.CityCode]
				if c == nil {
					c = &cityAgg{FootCity: FootCity{Code: w.CityCode, Name: w.City, Province: w.Province}}
					cityCount[w.CityCode] = c
				}
				c.Count++
				c.sumLng += w.Lng
				c.sumLat += w.Lat
			}
		}
	}

	sort.SliceStable(out.Trips, func(i, j int) bool { return out.Trips[i].sortKey.Before(out.Trips[j].sortKey) })

	// Evenly down-sample points if needed.
	if len(points) > MaxFootprintPoints {
		step := float64(len(points)) / MaxFootprintPoints
		sampled := make([]FootPoint, 0, MaxFootprintPoints)
		for i := 0; i < MaxFootprintPoints; i++ {
			sampled = append(sampled, points[int(float64(i)*step)])
		}
		points = sampled
	}
	if points != nil {
		out.Points = points
	}
	for _, p := range provCount {
		out.Provinces = append(out.Provinces, *p)
	}
	sort.Slice(out.Provinces, func(i, j int) bool {
		if out.Provinces[i].Count != out.Provinces[j].Count {
			return out.Provinces[i].Count > out.Provinces[j].Count
		}
		return out.Provinces[i].Code < out.Provinces[j].Code
	})
	for _, c := range cityCount {
		fc := c.FootCity
		fc.Lng = geo.Round(c.sumLng/float64(c.Count), 6)
		fc.Lat = geo.Round(c.sumLat/float64(c.Count), 6)
		out.Cities = append(out.Cities, fc)
	}
	sort.Slice(out.Cities, func(i, j int) bool {
		if out.Cities[i].Count != out.Cities[j].Count {
			return out.Cities[i].Count > out.Cities[j].Count
		}
		return out.Cities[i].Code < out.Cities[j].Code
	})

	out.Stats.DistanceKm = geo.Round(out.Stats.DistanceKm, 1)
	out.Stats.Days = len(dates)
	out.Stats.Cities = len(cityCount)
	out.Stats.Provinces = len(provCount)
	if !first.IsZero() {
		f, l := first.Format("2006-01-02"), last.Format("2006-01-02")
		out.Stats.FirstDate, out.Stats.LastDate = &f, &l
	}
	return out, nil
}

func (s *Service) pointDate(t *model.Trip, w *model.Waypoint) *string {
	switch {
	case w.ArrivedAt != nil:
		d := DateOnly(*w.ArrivedAt, s.Loc).Format("2006-01-02")
		return &d
	case t.StartDate != nil && w.Day > 0:
		d := t.StartDate.UTC().AddDate(0, 0, w.Day-1).Format("2006-01-02")
		return &d
	case t.StartDate != nil:
		return FormatDate(t.StartDate)
	}
	return nil
}
