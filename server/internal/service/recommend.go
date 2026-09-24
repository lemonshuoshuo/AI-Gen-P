package service

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"sort"
	"strings"
	"time"

	"triphub/internal/geo"
	"triphub/internal/model"
)

// Suggestion is a recommended next stop.
type Suggestion struct {
	Name       string  `json:"name"`
	Address    string  `json:"address"`
	Lng        float64 `json:"lng"`
	Lat        float64 `json:"lat"`
	Category   string  `json:"category"`
	DistanceM  int     `json:"distance_m"`
	Reason     string  `json:"reason"`
	Source     string  `json:"source"`
	PlaceID    *int64  `json:"place_id"`
	AmapID     string  `json:"amap_id"`
	RatingAvg  float64 `json:"rating_avg"`
	WaypointID *int64  `json:"waypoint_id,omitempty"`

	score float64
}

// Warning flags a nearby place many people marked as 踩雷.
type Warning struct {
	PlaceID   int64  `json:"place_id"`
	Name      string `json:"name"`
	DistanceM int    `json:"distance_m"`
	Reason    string `json:"reason"`
}

// Recommendation is the result of Recommend.
type Recommendation struct {
	NextPlanned          *model.Waypoint
	NextPlannedDistanceM *int
	Suggestions          []Suggestion
	Warnings             []Warning
	AIText               *string
	AIUsed               bool
}

// CategoryNames maps categories to Chinese labels.
var CategoryNames = map[string]string{
	"scenic": "景点", "food": "美食", "hotel": "住宿", "shopping": "购物",
	"transport": "交通", "entertainment": "娱乐", "other": "其他",
}

// dayPeriod classifies a local time for recommendation purposes.
func dayPeriod(t time.Time) (key, label string) {
	m := t.Hour()*60 + t.Minute()
	switch {
	case m >= 390 && m < 570:
		return "breakfast", "早上"
	case m >= 570 && m < 660:
		return "day", "上午"
	case m >= 660 && m < 810:
		return "meal", "中午"
	case m >= 810 && m < 1020:
		return "day", "下午"
	case m >= 1020 && m < 1200:
		return "meal", "傍晚"
	case m >= 1200 && m < 1320:
		return "night", "晚上"
	default:
		return "night", "深夜"
	}
}

func timeBoost(period, category string) float64 {
	switch period {
	case "meal":
		if category == "food" {
			return 20
		}
	case "breakfast":
		if category == "food" {
			return 10
		}
	case "night":
		switch category {
		case "hotel":
			return 12
		case "entertainment":
			return 10
		case "food":
			return 5
		case "scenic":
			return -8
		}
	case "day":
		switch category {
		case "scenic":
			return 10
		case "shopping", "entertainment":
			return 3
		}
	}
	return 0
}

func amapTypesFor(period string) string {
	switch period {
	case "meal", "breakfast":
		return "050000"
	case "night":
		return "050000|080000|100000"
	}
	return "110000|140000"
}

// FormatDistance renders metres as "420 米" / "1.2 公里".
func FormatDistance(m float64) string {
	if m < 1000 {
		return fmt.Sprintf("%d 米", int(math.Round(m/10)*10))
	}
	return fmt.Sprintf("%.1f 公里", m/1000)
}

// Recommend suggests the next stops for a trip at position pos (GCJ-02, may be nil).
func (s *Service) Recommend(ctx context.Context, trip *model.Trip, pos *geo.Point, useAI bool, now time.Time) (*Recommendation, error) {
	now = now.In(s.Loc)
	period, _ := dayPeriod(now)
	var wps []model.Waypoint
	if err := s.DB.WithContext(ctx).Where("trip_id = ?", trip.ID).Order("seq, id").Find(&wps).Error; err != nil {
		return nil, err
	}
	var todo []model.Waypoint
	for _, w := range wps {
		if w.Planned && w.Status == model.WPTodo {
			todo = append(todo, w)
		}
	}
	actual := ActualRoute(wps)
	if pos == nil {
		switch {
		case len(actual) > 0:
			last := actual[len(actual)-1]
			pos = &geo.Point{Lng: last.Lng, Lat: last.Lat}
		case len(todo) > 0:
			pos = &geo.Point{Lng: todo[0].Lng, Lat: todo[0].Lat}
		}
	}
	dist := func(lng, lat float64) float64 {
		if pos == nil {
			return 0
		}
		return geo.Haversine(pos.Lng, pos.Lat, lng, lat)
	}

	res := &Recommendation{Suggestions: []Suggestion{}, Warnings: []Warning{}}
	if len(todo) > 0 {
		n := todo[0]
		res.NextPlanned = &n
		if pos != nil {
			d := int(math.Round(dist(n.Lng, n.Lat)))
			res.NextPlannedDistanceM = &d
		}
	}

	var cands []Suggestion
	for i, w := range todo {
		if i >= 3 {
			break
		}
		d := dist(w.Lng, w.Lat)
		reason := "计划中的下一站"
		if i > 0 {
			reason = "计划中的后续站点"
		}
		if pos != nil {
			reason += "，距离 " + FormatDistance(d)
		}
		if w.Note != "" {
			reason += "；备注：" + Truncate(w.Note, 20)
		}
		id := w.ID
		cands = append(cands, Suggestion{
			Name: w.Name, Address: w.Address, Lng: w.Lng, Lat: w.Lat, Category: w.Category,
			DistanceM: int(math.Round(d)), Reason: reason, Source: "plan", PlaceID: w.PlaceID, AmapID: w.AmapID,
			WaypointID: &id, score: 1000 - float64(i)*10,
		})
	}

	inTripPlace := map[int64]bool{}
	inTripAmap := map[string]bool{}
	for _, w := range wps {
		if w.PlaceID != nil {
			inTripPlace[*w.PlaceID] = true
		}
		if w.AmapID != "" {
			inTripAmap[w.AmapID] = true
		}
	}

	if pos != nil {
		minLng, minLat, maxLng, maxLat := geo.BBoxAround(pos.Lng, pos.Lat, 3000)
		var places []model.Place
		if err := s.DB.WithContext(ctx).Where("checkin_count > 0 AND lng BETWEEN ? AND ? AND lat BETWEEN ? AND ?", minLng, maxLng, minLat, maxLat).
			Order("checkin_count DESC").Limit(100).Find(&places).Error; err != nil {
			return nil, err
		}
		for _, p := range places {
			d := dist(p.Lng, p.Lat)
			if d > 3000 {
				continue
			}
			if p.AvoidCount >= 1 && p.AvoidCount > p.RecommendCount {
				if d <= 2000 {
					res.Warnings = append(res.Warnings, Warning{PlaceID: p.ID, Name: p.Name, DistanceM: int(math.Round(d)), Reason: s.avoidReason(ctx, &p)})
				}
				continue
			}
			if inTripPlace[p.ID] || (p.AmapID != "" && inTripAmap[p.AmapID]) {
				continue
			}
			rated := p.RecommendCount + p.NeutralCount + p.AvoidCount
			recRate := 0.5
			if rated > 0 {
				recRate = float64(p.RecommendCount) / float64(rated)
			}
			score := 40*recRate + 6*p.RatingAvg + 6*math.Log1p(float64(p.CheckinCount)) - d/150 + timeBoost(period, p.Category)
			parts := []string{fmt.Sprintf("附近 %d 人打卡", p.CheckinCount)}
			if rated > 0 {
				parts = append(parts, fmt.Sprintf("推荐率 %d%%", int(math.Round(recRate*100))))
			}
			if p.RatingAvg > 0 {
				parts = append(parts, fmt.Sprintf("评分 %.1f", p.RatingAvg))
			}
			if p.AvgCost > 0 {
				parts = append(parts, fmt.Sprintf("人均 ¥%d", int(math.Round(p.AvgCost))))
			}
			parts = append(parts, "距离 "+FormatDistance(d))
			id := p.ID
			cands = append(cands, Suggestion{
				Name: p.Name, Address: p.Address, Lng: p.Lng, Lat: p.Lat, Category: p.Category,
				DistanceM: int(math.Round(d)), Reason: strings.Join(parts, "，"), Source: "community",
				PlaceID: &id, AmapID: p.AmapID, RatingAvg: p.RatingAvg, score: score,
			})
			if p.AmapID != "" {
				inTripAmap[p.AmapID] = true // avoid duplicating the same POI from AMap
			}
		}

		if s.Amap.Enabled() {
			actx, cancel := context.WithTimeout(ctx, 3*time.Second)
			pois, err := s.Amap.Around(actx, pos.Lng, pos.Lat, 2000, amapTypesFor(period), "", 15)
			cancel()
			if err == nil {
				for _, p := range pois {
					if p.ID != "" && inTripAmap[p.ID] {
						continue
					}
					d := p.Distance
					if d == 0 {
						d = dist(p.Lng, p.Lat)
					}
					sub := p.Type
					if i := strings.LastIndex(sub, ";"); i >= 0 {
						sub = sub[i+1:]
					}
					reason := "高德周边"
					if sub != "" {
						reason += " · " + sub
					}
					reason += " · 距离 " + FormatDistance(d)
					cands = append(cands, Suggestion{
						Name: p.Name, Address: p.Address, Lng: p.Lng, Lat: p.Lat, Category: p.Category,
						DistanceM: int(math.Round(d)), Reason: reason, Source: "amap", AmapID: p.ID,
						score: 12 - d/200 + timeBoost(period, p.Category),
					})
				}
			}
		}
	}

	sort.SliceStable(cands, func(i, j int) bool { return cands[i].score > cands[j].score })
	sort.Slice(res.Warnings, func(i, j int) bool { return res.Warnings[i].DistanceM < res.Warnings[j].DistanceM })
	if len(res.Warnings) > 5 {
		res.Warnings = res.Warnings[:5]
	}
	res.Suggestions = pickRuleBased(cands, 5)

	if useAI && s.AI.Enabled() && len(cands) > 0 {
		if err := s.aiRerank(ctx, trip, wps, todo, actual, cands, pos, now, res); err != nil {
			slog.Warn("ai recommend failed, using rule-based results", "trip", trip.ID, "err", err)
		}
	}
	return res, nil
}

// pickRuleBased keeps the next planned stop first and fills the rest by score,
// allowing at most two further plan items so that nearby ideas also appear.
func pickRuleBased(cands []Suggestion, limit int) []Suggestion {
	out := []Suggestion{}
	plans := 0
	for _, c := range cands {
		if len(out) >= limit {
			break
		}
		if c.Source == "plan" {
			if plans >= 2 {
				continue
			}
			plans++
		}
		out = append(out, c)
	}
	return out
}

func (s *Service) avoidReason(ctx context.Context, p *model.Place) string {
	var notes []string
	s.DB.WithContext(ctx).Raw(`
SELECT w.note FROM waypoints w JOIN trips t ON t.id = w.trip_id
WHERE w.place_id = ? AND w.verdict = 'avoid' AND w.status = 'visited' AND w.note <> ''
  AND t.visibility = 'public' AND t.status = 'normal'
ORDER BY w.updated_at DESC LIMIT 3`, p.ID).Scan(&notes)
	reason := fmt.Sprintf("%d 人踩雷", p.AvoidCount)
	if len(notes) > 0 {
		for i, n := range notes {
			notes[i] = Truncate(strings.ReplaceAll(strings.TrimSpace(n), "\n", " "), 15)
		}
		reason += "：" + strings.Join(notes, "；")
	}
	return reason
}

type aiRecommendReply struct {
	Picks []struct {
		Index  int    `json:"index"`
		Reason string `json:"reason"`
	} `json:"picks"`
	Text  string `json:"text"`
	Ideas []struct {
		Name   string `json:"name"`
		Reason string `json:"reason"`
	} `json:"ideas"`
}

func (s *Service) aiRerank(ctx context.Context, trip *model.Trip, wps, todo, actual []model.Waypoint, cands []Suggestion,
	pos *geo.Point, now time.Time, res *Recommendation) error {
	if len(cands) > 16 {
		cands = cands[:16]
	}
	_, periodLabel := dayPeriod(now)
	weekdays := []string{"日", "一", "二", "三", "四", "五", "六"}
	var b strings.Builder
	fmt.Fprintf(&b, "当前时间：%s（星期%s，%s）\n", now.Format("2006-01-02 15:04"), weekdays[now.Weekday()], periodLabel)
	city := ""
	if pos != nil {
		info := s.Locate(ctx, pos.Lng, pos.Lat, false)
		city = info.City
		fmt.Fprintf(&b, "当前位置：%s%s（经纬度 %.5f,%.5f）\n", info.Province, strings.TrimPrefix(info.City, info.Province), pos.Lng, pos.Lat)
	}
	fmt.Fprintf(&b, "旅程：%s", trip.Title)
	if d := DayOfTrip(trip.StartDate, &now, s.Loc); d > 0 {
		fmt.Fprintf(&b, "（第 %d 天）", d)
	}
	b.WriteString("\n")
	names := func(list []model.Waypoint, max int) string {
		var n []string
		for i, w := range list {
			if i >= max {
				n = append(n, "…")
				break
			}
			n = append(n, w.Name)
		}
		if len(n) == 0 {
			return "无"
		}
		return strings.Join(n, "、")
	}
	fmt.Fprintf(&b, "已去过：%s\n", names(actual, 15))
	fmt.Fprintf(&b, "计划中未去：%s\n", names(todo, 15))
	b.WriteString("候选地点（编号. 名称 | 类别 | 距离 | 说明）：\n")
	for i, c := range cands {
		fmt.Fprintf(&b, "%d. %s | %s | %s | %s\n", i+1, c.Name, CategoryNames[c.Category], FormatDistance(float64(c.DistanceM)), c.Reason)
	}
	if len(res.Warnings) > 0 {
		b.WriteString("附近的踩雷点（不要推荐）：")
		for i, w := range res.Warnings {
			if i > 0 {
				b.WriteString("；")
			}
			b.WriteString(w.Name + "（" + w.Reason + "）")
		}
		b.WriteString("\n")
	}
	b.WriteString(`请结合时间（饭点优先推荐美食、夜晚考虑住宿与夜景）、距离和计划，从候选地点中挑选最多 5 个现在最适合去的地点，按推荐顺序排列，每个给出 30 字以内的中文理由；再写一段 80 字以内的整体建议。
如果你知道候选之外、附近非常值得一去的地点，可以在 ideas 中给出最多 2 个（只写确实存在的真实地点名称）。
只输出 JSON，格式：{"picks":[{"index":1,"reason":"…"}],"text":"…","ideas":[{"name":"…","reason":"…"}]}`)

	actx, cancel := context.WithTimeout(ctx, s.Cfg.AITimeout)
	defer cancel()
	var reply aiRecommendReply
	system := "你是一名熟悉中国各地的资深旅行向导，根据游客的实时位置、时间和行程推荐下一站。回答必须是严格的 JSON。"
	if err := s.AI.ChatJSON(actx, system, b.String(), &reply); err != nil {
		return err
	}
	var picked []Suggestion
	used := map[int]bool{}
	for _, p := range reply.Picks {
		if p.Index < 1 || p.Index > len(cands) || used[p.Index] || len(picked) >= 5 {
			continue
		}
		used[p.Index] = true
		c := cands[p.Index-1]
		if r := strings.TrimSpace(p.Reason); r != "" {
			c.Reason = Truncate(r, 60)
		}
		picked = append(picked, c)
	}
	// Locate extra ideas through AMap so they carry real coordinates.
	if pos != nil && s.Amap.Enabled() {
		for i, idea := range reply.Ideas {
			if i >= 2 || len(picked) >= 6 || strings.TrimSpace(idea.Name) == "" {
				break
			}
			sctx, scancel := context.WithTimeout(ctx, 3*time.Second)
			pois, err := s.Amap.Search(sctx, idea.Name, city, city != "", 3)
			scancel()
			if err != nil || len(pois) == 0 {
				continue
			}
			p := pois[0]
			d := geo.Haversine(pos.Lng, pos.Lat, p.Lng, p.Lat)
			if d > 10000 {
				continue
			}
			picked = append(picked, Suggestion{
				Name: p.Name, Address: p.Address, Lng: p.Lng, Lat: p.Lat, Category: p.Category,
				DistanceM: int(math.Round(d)), Reason: Truncate(strings.TrimSpace(idea.Reason), 60), Source: "ai", AmapID: p.ID,
			})
		}
	}
	if len(picked) == 0 {
		return fmt.Errorf("ai returned no usable picks")
	}
	res.Suggestions = picked
	if t := strings.TrimSpace(reply.Text); t != "" {
		t = Truncate(t, 200)
		res.AIText = &t
	}
	res.AIUsed = true
	return nil
}
