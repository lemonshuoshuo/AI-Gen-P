// Package amap is a small client for the 高德 (AMap) Web Service API.
// All methods degrade gracefully: when no key is configured or the service is
// unreachable they return ErrUnavailable quickly, and callers fall back to
// the offline atlas.
package amap

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ErrUnavailable means the API is not configured or temporarily disabled.
var ErrUnavailable = errors.New("amap unavailable")

// ErrNotFound means AMap has no POI with the requested ID.
var ErrNotFound = errors.New("amap poi not found")

// ErrNoRoute means AMap found no route, e.g. no public transport between two points.
var ErrNoRoute = errors.New("amap: no route")

// DefaultBaseURL is the AMap REST endpoint.
const DefaultBaseURL = "https://restapi.amap.com"

// Client talks to the AMap web service API.
type Client struct {
	key       string
	baseURL   string
	http      *http.Client
	regeo     *lru[*Regeo]
	search    *lru[[]POI]  // Search results, by query
	around    *lru[[]POI]  // Around results, by query at a point snapped to ~100 m
	pois      *lru[POI]    // POIs seen in search / around / detail results, by ID
	dir       *lru[*Route] // Direction results, by mode and end points
	failUntil atomic.Int64 // unix nanos; circuit breaker after network / key errors
	lastWarn  atomic.Int64 // unix nanos of the last throttled warning

	// 路径规划 has a daily quota of its own: its key / quota errors pause
	// only Direction (dirFailUntil), not search. Its requests are spaced
	// dirGap apart; a caller whose turn is over dirMaxWait away gives up.
	dirFailUntil atomic.Int64
	dirMu        sync.Mutex
	dirNext      time.Time
	dirGap       time.Duration
	dirMaxWait   time.Duration
}

// New creates a client. An empty key yields a disabled client.
func New(key string) *Client {
	return &Client{
		key:     key,
		baseURL: DefaultBaseURL,
		http:    &http.Client{Timeout: 3 * time.Second},
		regeo:   newLRU[*Regeo](20000, 24*time.Hour),
		search:  newLRU[[]POI](2000, 30*time.Minute),
		around:  newLRU[[]POI](2000, 10*time.Minute),
		pois:    newLRU[POI](20000, 24*time.Hour),
		dir:     newLRU[*Route](20000, 7*24*time.Hour),
		// About 3 requests a second: the QPS limit of a personal key is low.
		dirGap:     300 * time.Millisecond,
		dirMaxWait: 3 * time.Second,
	}
}

// SetBaseURL overrides the API base URL (tests).
func (c *Client) SetBaseURL(u string) { c.baseURL = strings.TrimRight(u, "/") }

// Enabled reports whether a key is configured.
func (c *Client) Enabled() bool { return c != nil && c.key != "" }

func (c *Client) available() bool {
	return c.Enabled() && time.Now().UnixNano() >= c.failUntil.Load()
}

// flexString decodes AMap's habit of returning [] instead of "" for empty values.
type flexString string

func (f *flexString) UnmarshalJSON(b []byte) error {
	if len(b) > 0 && b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*f = flexString(s)
		return nil
	}
	if len(b) > 0 && b[0] == '[' {
		var arr []string
		if err := json.Unmarshal(b, &arr); err == nil && len(arr) > 0 {
			*f = flexString(strings.Join(arr, ""))
			return nil
		}
	}
	*f = ""
	return nil
}

type baseResp struct {
	Status   string `json:"status"`
	Info     string `json:"info"`
	Infocode string `json:"infocode"`
}

// AMap infocodes (https://lbs.amap.com/api/webservice/guide/tools/info).
var (
	// keyErrors: the key is invalid, not allowed for this service / platform
	// / IP, or its (daily) quota is used up, so every request would fail.
	keyErrors = map[string]bool{
		"10001": true, "10002": true, "10003": true, "10005": true, "10006": true, "10007": true, "10008": true,
		"10009": true, "10010": true, "10012": true, "10013": true, "10026": true, "10041": true, "10044": true,
	}
	// qpsErrors: too many requests per second; only this request failed.
	qpsErrors = map[string]bool{
		"10004": true, "10014": true, "10015": true, "10016": true, "10019": true, "10020": true, "10021": true,
	}
)

// warnAllowed reports whether a throttled warning may be logged now (at most
// once a minute).
func (c *Client) warnAllowed() bool {
	now := time.Now().UnixNano()
	last := c.lastWarn.Load()
	return now-last >= int64(time.Minute) && c.lastWarn.CompareAndSwap(last, now)
}

// apiError handles a response with status "0". Key and quota errors open
// the breaker (pausing its calls) for 10 minutes. Other errors only fail this
// request: QPS limits pass by themselves, and per-request errors (2xxxx /
// 3xxxx, e.g. 20012 for a keyword with illegal content) must not let crafted
// input disable AMap for everyone.
func (c *Client) apiError(breaker *atomic.Int64, path string, br baseResp) error {
	switch {
	case keyErrors[br.Infocode]:
		breaker.Store(time.Now().Add(10 * time.Minute).UnixNano())
		c.lastWarn.Store(time.Now().UnixNano())
		slog.Warn("高德 Key 无效或调用额度已用尽，暂停调用 10 分钟", "path", path, "infocode", br.Infocode, "info", br.Info)
	case qpsErrors[br.Infocode]:
		if c.warnAllowed() {
			slog.Warn("高德接口调用超出 QPS 限制", "path", path, "infocode", br.Infocode, "info", br.Info)
		}
	default:
		if c.warnAllowed() {
			slog.Warn("高德接口返回错误", "path", path, "infocode", br.Infocode, "info", br.Info)
		}
	}
	return fmt.Errorf("%w: amap error %s: %s", ErrUnavailable, br.Infocode, br.Info)
}

func (c *Client) get(ctx context.Context, path string, q url.Values, out any) error {
	return c.getWith(ctx, &c.failUntil, path, q, out)
}

// getWith is get for an API with a quota of its own: its key and quota
// errors open breaker instead of the shared one. Network errors still open
// the shared breaker.
func (c *Client) getWith(ctx context.Context, breaker *atomic.Int64, path string, q url.Values, out any) error {
	if !c.available() || time.Now().UnixNano() < breaker.Load() {
		return ErrUnavailable
	}
	q.Set("key", c.key)
	q.Set("output", "JSON")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path+"?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			// The caller went away (browser abort, client disconnect): not
			// an AMap failure, so the breaker stays closed.
			return fmt.Errorf("%w: %v", ErrUnavailable, ctx.Err())
		}
		// Network failure or timeout: back off for a while so requests fail fast.
		c.failUntil.Store(time.Now().Add(60 * time.Second).UnixNano())
		msg := strings.ReplaceAll(err.Error(), c.key, "***") // never log the key
		slog.Warn("amap request failed, disabling for 60s", "path", path, "err", msg)
		return fmt.Errorf("%w: %s", ErrUnavailable, msg)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		c.failUntil.Store(time.Now().Add(30 * time.Second).UnixNano())
		slog.Warn("amap returned an error status, disabling for 30s", "path", path, "status", resp.StatusCode)
		return fmt.Errorf("%w: http %d", ErrUnavailable, resp.StatusCode)
	}
	raw := json.RawMessage{}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return fmt.Errorf("amap decode: %w", err)
	}
	var br baseResp
	_ = json.Unmarshal(raw, &br)
	if br.Status != "1" {
		return c.apiError(breaker, path, br)
	}
	return json.Unmarshal(raw, out)
}

// POI is a place returned by search. Coordinates are GCJ-02.
type POI struct {
	ID       string
	Name     string
	Address  string
	Province string
	City     string
	District string
	Type     string
	Category string
	Tel      string
	Lng, Lat float64
	Distance float64 // metres, only for around-search
}

type poiJSON struct {
	ID       flexString `json:"id"`
	Name     flexString `json:"name"`
	Type     flexString `json:"type"`
	Address  flexString `json:"address"`
	Location flexString `json:"location"`
	Pname    flexString `json:"pname"`
	Cityname flexString `json:"cityname"`
	Adname   flexString `json:"adname"`
	Tel      flexString `json:"tel"`
	Distance flexString `json:"distance"`
}

func (p poiJSON) toPOI() (POI, bool) {
	lng, lat, ok := parseLocation(string(p.Location))
	if !ok {
		return POI{}, false
	}
	city := string(p.Cityname)
	if city == "" {
		city = string(p.Pname)
	}
	out := POI{
		ID: string(p.ID), Name: string(p.Name), Address: string(p.Address),
		Province: string(p.Pname), City: city, District: string(p.Adname),
		Type: string(p.Type), Category: Category(string(p.Type)), Tel: string(p.Tel),
		Lng: lng, Lat: lat,
	}
	if d, err := strconv.ParseFloat(string(p.Distance), 64); err == nil {
		out.Distance = d
	}
	return out, true
}

func parseLocation(s string) (float64, float64, bool) {
	parts := strings.Split(s, ",")
	if len(parts) != 2 {
		return 0, 0, false
	}
	lng, err1 := strconv.ParseFloat(strings.TrimSpace(parts[0]), 64)
	lat, err2 := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return lng, lat, true
}

// Search runs a keyword search (/v3/place/text). city may be empty;
// cityLimit restricts results to that city. Results are cached for 30
// minutes; the returned slice is shared and must not be modified.
func (c *Client) Search(ctx context.Context, keyword, city string, cityLimit bool, limit int) ([]POI, error) {
	if limit <= 0 || limit > 25 {
		limit = 20
	}
	key := fmt.Sprintf("%s\x00%s\x00%t\x00%d", keyword, city, cityLimit, limit)
	if ps, ok := c.search.Get(key); ok {
		return c.remember(ps), nil // refreshed for CachedPOI, as after a request
	}
	q := url.Values{}
	q.Set("keywords", keyword)
	if city != "" {
		q.Set("city", city)
		if cityLimit {
			q.Set("citylimit", "true")
		}
	}
	q.Set("offset", strconv.Itoa(limit))
	q.Set("page", "1")
	q.Set("extensions", "base")
	var resp struct {
		Pois []poiJSON `json:"pois"`
	}
	if err := c.get(ctx, "/v3/place/text", q, &resp); err != nil {
		return nil, err
	}
	out := c.remember(convertPOIs(resp.Pois))
	c.search.Put(key, out)
	return out, nil
}

// Around searches near a GCJ-02 point (/v3/place/around), sorted by distance.
// types is an AMap type code list such as "050000|110000". The point is
// snapped to a grid of about 100 m and results are cached for 10 minutes, so
// POI.Distance is measured from the snapped point; the returned slice is
// shared and must not be modified.
func (c *Client) Around(ctx context.Context, lng, lat float64, radius int, types, keyword string, limit int) ([]POI, error) {
	if limit <= 0 || limit > 25 {
		limit = 20
	}
	lng, lat = math.Round(lng*1000)/1000, math.Round(lat*1000)/1000
	key := fmt.Sprintf("%.3f,%.3f|%d|%s|%s|%d", lng, lat, radius, types, keyword, limit)
	if ps, ok := c.around.Get(key); ok {
		return c.remember(ps), nil // refreshed for CachedPOI, as after a request
	}
	q := url.Values{}
	q.Set("location", fmt.Sprintf("%.6f,%.6f", lng, lat))
	q.Set("radius", strconv.Itoa(radius))
	if types != "" {
		q.Set("types", types)
	}
	if keyword != "" {
		q.Set("keywords", keyword)
	}
	q.Set("sortrule", "distance")
	q.Set("offset", strconv.Itoa(limit))
	q.Set("page", "1")
	q.Set("extensions", "base")
	var resp struct {
		Pois []poiJSON `json:"pois"`
	}
	if err := c.get(ctx, "/v3/place/around", q, &resp); err != nil {
		return nil, err
	}
	out := c.remember(convertPOIs(resp.Pois))
	c.around.Put(key, out)
	return out, nil
}

// remember caches POIs returned by AMap by their ID (see CachedPOI).
func (c *Client) remember(ps []POI) []POI {
	for _, p := range ps {
		if p.ID != "" {
			c.pois.Put(p.ID, p)
		}
	}
	return ps
}

// CachedPOI returns AMap's own data for a POI recently returned by search,
// around or detail lookups; it never hits the network.
func (c *Client) CachedPOI(id string) (POI, bool) {
	if c == nil || c.pois == nil || id == "" {
		return POI{}, false
	}
	return c.pois.Get(id)
}

// Detail looks up a POI by its ID (/v3/place/detail); results are cached.
// It returns ErrNotFound when AMap has no such POI.
func (c *Client) Detail(ctx context.Context, id string) (*POI, error) {
	if p, ok := c.CachedPOI(id); ok {
		return &p, nil
	}
	q := url.Values{}
	q.Set("id", id)
	var resp struct {
		Pois []poiJSON `json:"pois"`
	}
	if err := c.get(ctx, "/v3/place/detail", q, &resp); err != nil {
		return nil, err
	}
	for _, p := range c.remember(convertPOIs(resp.Pois)) {
		if p.ID == id {
			return &p, nil
		}
	}
	return nil, ErrNotFound
}

func convertPOIs(in []poiJSON) []POI {
	out := make([]POI, 0, len(in))
	for _, p := range in {
		if poi, ok := p.toPOI(); ok {
			out = append(out, poi)
		}
	}
	return out
}

// Regeo is a reverse-geocoding result.
type Regeo struct {
	Province         string
	City             string
	District         string
	Township         string
	FormattedAddress string
	Adcode           string
}

// Regeo reverse-geocodes a GCJ-02 point (cached).
func (c *Client) Regeo(ctx context.Context, lng, lat float64) (*Regeo, error) {
	key := fmt.Sprintf("%.5f,%.5f", lng, lat)
	if r, ok := c.regeo.Get(key); ok {
		return r, nil
	}
	q := url.Values{}
	q.Set("location", fmt.Sprintf("%.6f,%.6f", lng, lat))
	q.Set("extensions", "base")
	var resp struct {
		Regeocode struct {
			FormattedAddress flexString `json:"formatted_address"`
			AddressComponent struct {
				Province flexString `json:"province"`
				City     flexString `json:"city"`
				District flexString `json:"district"`
				Township flexString `json:"township"`
				Adcode   flexString `json:"adcode"`
			} `json:"addressComponent"`
		} `json:"regeocode"`
	}
	if err := c.get(ctx, "/v3/geocode/regeo", q, &resp); err != nil {
		return nil, err
	}
	ac := resp.Regeocode.AddressComponent
	r := &Regeo{
		Province: string(ac.Province), City: string(ac.City), District: string(ac.District),
		Township: string(ac.Township), FormattedAddress: string(resp.Regeocode.FormattedAddress),
		Adcode: string(ac.Adcode),
	}
	if r.City == "" {
		r.City = r.Province // municipalities
	}
	c.regeo.Put(key, r)
	return r, nil
}

// Route is a 路径规划 result.
type Route struct {
	Mode      string // walking, transit or driving
	DistanceM int
	DurationS int
}

// Direction plans a trip between two GCJ-02 points. mode is "walking"
// (/v3/direction/walking), "driving" (/v3/direction/driving) or "transit"
// (/v3/direction/transit/integrated: city and cityd are the city names of
// both ends; ErrNoRoute when AMap has no public transport between them).
// Successful results are cached for 7 days (the returned Route is shared and
// must not be modified); requests are throttled (see throttle).
func (c *Client) Direction(ctx context.Context, mode string, fromLng, fromLat, toLng, toLat float64, city, cityd string) (*Route, error) {
	q := url.Values{}
	var path string
	switch mode {
	case "walking":
		path = "/v3/direction/walking"
	case "driving":
		path = "/v3/direction/driving"
		q.Set("extensions", "base")
		q.Set("strategy", "0")
	case "transit":
		path = "/v3/direction/transit/integrated"
		q.Set("city", city)
		q.Set("cityd", cityd)
	default:
		return nil, fmt.Errorf("amap: unknown direction mode %q", mode)
	}
	key := fmt.Sprintf("%s|%.5f,%.5f|%.5f,%.5f|%s|%s", mode, fromLng, fromLat, toLng, toLat, city, cityd)
	if r, ok := c.dir.Get(key); ok {
		return r, nil
	}
	if !c.available() || time.Now().UnixNano() < c.dirFailUntil.Load() {
		return nil, ErrUnavailable
	}
	if err := c.throttle(ctx); err != nil {
		return nil, err
	}
	q.Set("origin", fmt.Sprintf("%.6f,%.6f", fromLng, fromLat))
	q.Set("destination", fmt.Sprintf("%.6f,%.6f", toLng, toLat))
	type leg struct {
		Distance flexString `json:"distance"`
		Duration flexString `json:"duration"`
	}
	var resp struct {
		Route struct {
			Distance flexString `json:"distance"`
			Paths    []leg      `json:"paths"`
			Transits []leg      `json:"transits"`
		} `json:"route"`
	}
	if err := c.getWith(ctx, &c.dirFailUntil, path, q, &resp); err != nil {
		return nil, err
	}
	legs := resp.Route.Paths
	if mode == "transit" {
		legs = resp.Route.Transits
	}
	if len(legs) == 0 {
		return nil, ErrNoRoute
	}
	dist, okDist := roundNumber(legs[0].Distance)
	if !okDist && mode == "transit" {
		dist, okDist = roundNumber(resp.Route.Distance)
	}
	dur, okDur := roundNumber(legs[0].Duration)
	if !okDist || !okDur {
		return nil, ErrNoRoute
	}
	r := &Route{Mode: mode, DistanceM: dist, DurationS: dur}
	c.dir.Put(key, r)
	return r, nil
}

// roundNumber parses one of AMap's numeric strings (metres, seconds).
func roundNumber(s flexString) (int, bool) {
	v, err := strconv.ParseFloat(strings.TrimSpace(string(s)), 64)
	if err != nil || !(v >= 0 && v < 1e9) {
		return 0, false
	}
	return int(math.Round(v)), true
}

// throttle waits for the caller's turn to send a 路径规划 request (one every
// dirGap). A caller whose turn is more than dirMaxWait away gives up at once
// with ErrUnavailable, so a burst of callers cannot build up a long queue.
func (c *Client) throttle(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	c.dirMu.Lock()
	now := time.Now()
	wait := max(c.dirNext.Sub(now), 0)
	if wait > c.dirMaxWait {
		c.dirMu.Unlock()
		return fmt.Errorf("%w: too many direction requests", ErrUnavailable)
	}
	c.dirNext = now.Add(wait + c.dirGap)
	c.dirMu.Unlock()
	if wait == 0 {
		return nil
	}
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("%w: %v", ErrUnavailable, ctx.Err())
	}
}

// Category maps an AMap POI type string ("餐饮服务;中餐厅;浙江菜") to a TripHub category.
func Category(t string) string {
	switch {
	case t == "":
		return "other"
	case strings.Contains(t, "餐饮"):
		return "food"
	case strings.Contains(t, "风景名胜"), strings.Contains(t, "公园广场"), strings.Contains(t, "博物馆"):
		return "scenic"
	case strings.Contains(t, "住宿"):
		return "hotel"
	case strings.Contains(t, "购物"):
		return "shopping"
	case strings.Contains(t, "交通设施"):
		return "transport"
	case strings.Contains(t, "休闲娱乐"), strings.Contains(t, "体育休闲"):
		return "entertainment"
	}
	return "other"
}
