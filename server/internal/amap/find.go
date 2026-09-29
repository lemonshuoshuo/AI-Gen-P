package amap

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode"
)

type tipJSON struct {
	ID       flexString `json:"id"`
	Name     flexString `json:"name"`
	District flexString `json:"district"`
	Adcode   flexString `json:"adcode"`
	Location flexString `json:"location"`
	Address  flexString `json:"address"`
	Typecode flexString `json:"typecode"`
}

// toPOI converts an input tip. Tips without an ID or a usable location
// (keyword suggestions, bus lines) are dropped.
func (t tipJSON) toPOI() (POI, bool) {
	id, name := strings.TrimSpace(string(t.ID)), strings.TrimSpace(string(t.Name))
	lng, lat, ok := parseLocation(string(t.Location))
	if !ok || id == "" || name == "" {
		return POI{}, false
	}
	prov, city, dist := SplitRegion(string(t.District))
	return POI{ID: id, Name: name, Address: string(t.Address), Province: prov, City: city, District: dist,
		Category: CategoryFromTypecode(string(t.Typecode)), Adcode: string(t.Adcode), Lng: lng, Lat: lat}, true
}

// SplitRegion splits an AMap district string such as "浙江省台州市椒江区"
// or "北京市东城区" into province, city and district (best effort; parts it
// cannot tell are "").
func SplitRegion(s string) (province, city, district string) {
	s = strings.TrimSpace(s)
	for _, m := range []string{"北京市", "上海市", "天津市", "重庆市"} {
		if strings.HasPrefix(s, m) {
			return m, m, strings.TrimPrefix(s, m)
		}
	}
	for _, suf := range []string{"特别行政区", "自治区", "省"} {
		if i := strings.Index(s, suf); i > 0 {
			province, s = s[:i+len(suf)], s[i+len(suf):]
			break
		}
	}
	end := -1
	for _, suf := range []string{"自治州", "地区", "盟", "市"} {
		if i := strings.Index(s, suf); i > 0 && (end < 0 || i+len(suf) < end) {
			end = i + len(suf)
		}
	}
	if end > 0 {
		city, s = s[:end], s[end:]
	}
	return province, city, s
}

// Find is the search box: a keyword search (/v3/place/text, with AMap's
// rating and cost) and input tips (/v3/assistant/inputtips, which also
// know small shops and 民宿 that the keyword search misses) run in parallel
// and are merged: deduplicated by POI ID, exact and prefix name matches
// first, then in place/text order followed by the remaining tips. city is
// a hint (results elsewhere are kept). Results are cached for 30 minutes;
// the returned slice is shared and must not be modified. It fails only when
// both requests fail.
func (c *Client) Find(ctx context.Context, keyword, city string, limit int) ([]POI, error) {
	if limit <= 0 || limit > 25 {
		limit = 20
	}
	key := fmt.Sprintf("find\x00%s\x00%s\x00%d", keyword, city, limit)
	if ps, ok := c.search.Get(key); ok {
		return c.remember(ps), nil
	}
	if err := c.available(); err != nil {
		return nil, err
	}
	var (
		wg              sync.WaitGroup
		texts, tips     []POI
		textErr, tipErr error
	)
	wg.Add(2)
	go func() {
		defer wg.Done()
		q := url.Values{}
		q.Set("keywords", keyword)
		if city != "" {
			q.Set("city", city)
			q.Set("citylimit", "false")
		}
		q.Set("offset", strconv.Itoa(limit))
		q.Set("page", "1")
		q.Set("extensions", "all")
		var resp struct {
			Pois flexList[poiJSON] `json:"pois"`
		}
		if textErr = c.get(ctx, "/v3/place/text", q, &resp); textErr == nil {
			texts = convertPOIs(resp.Pois)
		}
	}()
	go func() {
		defer wg.Done()
		q := url.Values{}
		q.Set("keywords", keyword)
		if city != "" {
			q.Set("city", city)
		}
		q.Set("citylimit", "false")
		q.Set("datatype", "all")
		var resp struct {
			Tips flexList[tipJSON] `json:"tips"`
		}
		if tipErr = c.get(ctx, "/v3/assistant/inputtips", q, &resp); tipErr == nil {
			for _, t := range resp.Tips {
				if p, ok := t.toPOI(); ok {
					tips = append(tips, p)
				}
			}
		}
	}()
	wg.Wait()
	if textErr != nil && tipErr != nil {
		var e *Error
		if !errors.As(textErr, &e) && errors.As(tipErr, &e) {
			return nil, tipErr // the more telling one
		}
		return nil, textErr
	}
	out := c.remember(mergeFind(keyword, texts, tips, limit))
	if textErr == nil && tipErr == nil {
		c.search.Put(key, out)
	}
	return out, nil
}

// mergeFind merges keyword-search results and input tips (see Find).
func mergeFind(keyword string, texts, tips []POI, limit int) []POI {
	out := make([]POI, 0, len(texts)+len(tips))
	seen := map[string]bool{}
	for _, list := range [][]POI{texts, tips} {
		for _, p := range list {
			if p.ID != "" {
				if seen[p.ID] {
					continue
				}
				seen[p.ID] = true
			}
			out = append(out, p)
		}
	}
	ranks := make([]int, len(out))
	for i := range out {
		ranks[i] = nameRank(keyword, out[i])
	}
	idx := make([]int, len(out))
	for i := range idx {
		idx[i] = i
	}
	sort.SliceStable(idx, func(a, b int) bool { return ranks[idx[a]] < ranks[idx[b]] })
	sorted := make([]POI, 0, min(len(out), limit))
	for _, i := range idx {
		if len(sorted) >= limit {
			break
		}
		sorted = append(sorted, out[i])
	}
	return sorted
}

// nameRank is 0 for a POI whose name equals the keyword, 1 when it starts
// with it, 2 otherwise. A keyword that starts with the POI's city or
// district ("台州那海民宿" for 那海民宿 in 台州市) is also tried without it.
func nameRank(keyword string, p POI) int {
	name := normName(p.Name)
	kw := normName(keyword)
	variants := []string{kw}
	for _, region := range []string{p.City, p.District, p.Province} {
		for _, r := range []string{normName(region), normName(trimRegionSuffix(region))} {
			if r != "" && strings.HasPrefix(kw, r) && len(kw) > len(r) {
				variants = append(variants, strings.TrimPrefix(kw, r))
			}
		}
	}
	best := 2
	for _, v := range variants {
		switch {
		case v == "":
		case name == v:
			return 0
		case strings.HasPrefix(name, v):
			best = 1
		}
	}
	return best
}

func trimRegionSuffix(s string) string {
	for _, suf := range []string{"特别行政区", "自治区", "自治州", "地区", "省", "市", "区", "县"} {
		if t := strings.TrimSuffix(s, suf); t != s && len([]rune(t)) >= 2 {
			return t
		}
	}
	return s
}

// normName lower-cases s and drops spaces and punctuation, so that
// "那海 民宿（椒江店）" and "那海民宿(椒江店)" compare equal.
func normName(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if unicode.IsSpace(r) || unicode.IsPunct(r) || unicode.IsSymbol(r) {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// Tips asks the input tips (/v3/assistant/inputtips) for POIs matching
// keyword; city (a name or adcode) with cityLimit keeps only those in that
// city. Tips without a POI ID or position are dropped. Results are cached
// for 30 minutes; the returned slice is shared and must not be modified.
func (c *Client) Tips(ctx context.Context, keyword, city string, cityLimit bool) ([]POI, error) {
	key := fmt.Sprintf("tips\x00%s\x00%s\x00%t", keyword, city, cityLimit)
	if ps, ok := c.search.Get(key); ok {
		return c.remember(ps), nil
	}
	q := url.Values{}
	q.Set("keywords", keyword)
	if city != "" {
		q.Set("city", city)
	}
	q.Set("citylimit", strconv.FormatBool(cityLimit && city != ""))
	q.Set("datatype", "poi")
	var resp struct {
		Tips flexList[tipJSON] `json:"tips"`
	}
	if err := c.get(ctx, "/v3/assistant/inputtips", q, &resp); err != nil {
		return nil, err
	}
	out := []POI{}
	for _, t := range resp.Tips {
		if p, ok := t.toPOI(); ok {
			out = append(out, p)
		}
	}
	c.remember(out)
	c.search.Put(key, out)
	return out, nil
}

// Geocode finds a place name or address (/v3/geocode/geo): the first match,
// with its province, city, district and adcode (Name is the formatted
// address). ErrNotFound when AMap knows none. Results are cached for 30
// minutes.
func (c *Client) Geocode(ctx context.Context, address string) (*POI, error) {
	key := "geo\x00" + address
	if ps, ok := c.search.Get(key); ok {
		if len(ps) == 0 {
			return nil, ErrNotFound
		}
		p := ps[0]
		return &p, nil
	}
	q := url.Values{}
	q.Set("address", address)
	var resp struct {
		Geocodes flexList[struct {
			FormattedAddress flexString `json:"formatted_address"`
			Province         flexString `json:"province"`
			City             flexString `json:"city"`
			District         flexString `json:"district"`
			Adcode           flexString `json:"adcode"`
			Location         flexString `json:"location"`
		}] `json:"geocodes"`
	}
	if err := c.get(ctx, "/v3/geocode/geo", q, &resp); err != nil {
		return nil, err
	}
	var out []POI
	for _, g := range resp.Geocodes {
		lng, lat, ok := parseLocation(string(g.Location))
		if !ok || IsCountry(string(g.Province)) {
			continue
		}
		city := string(g.City)
		if city == "" {
			city = string(g.Province) // municipalities
		}
		out = append(out, POI{Name: string(g.FormattedAddress), Province: string(g.Province), City: city,
			District: string(g.District), Adcode: string(g.Adcode), Lng: lng, Lat: lat})
		break
	}
	c.search.Put(key, out)
	if len(out) == 0 {
		return nil, ErrNotFound
	}
	p := out[0]
	return &p, nil
}

// NameSimilarity rates how well a place name found on the map matches the
// name asked for, from 0 (unrelated) to 1 (the same name, ignoring case,
// spaces, punctuation and a branch in brackets such as "（椒江店）"). A name
// contained in the other scores 0.7–1 by how much of it they share (the
// asked name may start with the city: "台州府城" for "府城"); others score
// by their common character pairs (Dice coefficient).
func NameSimilarity(asked, found string) float64 {
	a, b := normName(stripBranch(asked)), normName(stripBranch(found))
	if a == "" || b == "" {
		return 0
	}
	if a == b {
		return 1
	}
	ra, rb := []rune(a), []rune(b)
	if strings.Contains(a, b) || strings.Contains(b, a) {
		short, long := min(len(ra), len(rb)), max(len(ra), len(rb))
		return 0.7 + 0.3*float64(short)/float64(long)
	}
	pairs := func(r []rune) map[[2]rune]int {
		m := map[[2]rune]int{}
		for i := 1; i < len(r); i++ {
			m[[2]rune{r[i-1], r[i]}]++
		}
		return m
	}
	pa, pb := pairs(ra), pairs(rb)
	common := 0
	for k, n := range pa {
		common += min(n, pb[k])
	}
	total := len(ra) - 1 + len(rb) - 1
	if total <= 0 {
		return 0
	}
	return 2 * float64(common) / float64(total)
}

// stripBranch drops a trailing bracketed part ("楼外楼(孤山路店)" → "楼外楼")
// unless that leaves nothing.
func stripBranch(s string) string {
	s = strings.TrimSpace(s)
	for _, open := range []string{"(", "（"} {
		if i := strings.Index(s, open); i > 0 {
			return strings.TrimSpace(s[:i])
		}
	}
	return s
}
