// Package amap is a small client for the 高德 (AMap) Web Service API.
// All methods degrade gracefully: when no key is configured or the service is
// unreachable they return ErrUnavailable quickly, and callers fall back to
// the offline atlas. Failures carry an *Error that explains them (see
// ErrorMessage).
package amap

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"triphub/internal/geo"
	"triphub/internal/lru"
	"triphub/internal/netdiag"
)

// ErrUnavailable means the API is not configured or temporarily disabled.
var ErrUnavailable = errors.New("amap unavailable")

// ErrNotFound means AMap has no POI with the requested ID.
var ErrNotFound = errors.New("amap poi not found")

// ErrNoRoute means AMap found no route, e.g. no public transport between two points.
var ErrNoRoute = errors.New("amap: no route")

// ErrBusy means a 路径规划 request was not sent because too many are
// waiting for their turn (see throttle); a later request may succeed.
var ErrBusy = fmt.Errorf("%w: too many direction requests", ErrUnavailable)

// DefaultBaseURL is the AMap REST endpoint.
const DefaultBaseURL = "https://restapi.amap.com"

// RequestTimeout bounds a single request. Requests from servers in China
// occasionally take several seconds; 10 s also fits the admin diagnostics.
// Callers that pass a much shorter context deadline (background lookups
// with a local fallback) get the failure, but it does not count towards
// pausing AMap (see getWith).
const RequestTimeout = 10 * time.Second

// Network failures pause AMap (the shared breaker) only after netFailLimit
// failures in a row (any answer resets the count), for netPause: a single
// slow request must not switch AMap off for everyone. Failures of requests
// started within netFailGap of the last counted one count once (Find's two
// parallel requests, a burst of searches), so the limit takes failures at
// distinct times.
const (
	netFailLimit = 3
	netPause     = 20 * time.Second
	netFailGap   = 2 * time.Second
)

// Client talks to the AMap web service API.
type Client struct {
	key      string
	baseURL  string
	http     *http.Client
	regeo    *lru.Cache[*Regeo]
	detail   *lru.Cache[*RegeoDetail] // RegeoDetail results, by point
	search   *lru.Cache[[]POI]        // Search / Find results, by query
	around   *lru.Cache[[]POI]        // Around results, by query at a point snapped to ~100 m
	pois     *lru.Cache[POI]          // POIs seen in search / around / detail results, by ID
	dir      *lru.Cache[*Route]       // Direction results, by mode and end points
	fail     breaker                  // after network / key errors
	streak   netStreak                // network failures in a row
	netGap   time.Duration            // netFailGap (tests shorten it)
	lastWarn atomic.Int64             // unix nanos of the last throttled warning

	// 路径规划 has a daily quota of its own: its key / quota errors pause
	// only Direction (dirFail), not search. Its requests are spaced
	// dirGap apart; a caller whose turn is over dirMaxWait away gives up.
	dirFail    breaker
	dirMu      sync.Mutex
	dirNext    time.Time
	dirGap     time.Duration
	dirMaxWait time.Duration
}

// New creates a client. An empty key yields a disabled client.
func New(key string) *Client {
	return &Client{
		key:     key,
		baseURL: DefaultBaseURL,
		http:    &http.Client{Timeout: RequestTimeout},
		regeo:   lru.New[*Regeo](20000, 24*time.Hour),
		detail:  lru.New[*RegeoDetail](5000, 24*time.Hour),
		search:  lru.New[[]POI](2000, 30*time.Minute),
		around:  lru.New[[]POI](2000, 10*time.Minute),
		pois:    lru.New[POI](20000, 24*time.Hour),
		dir:     lru.New[*Route](20000, 7*24*time.Hour),
		netGap:  netFailGap,
		// About 3 requests a second: the QPS limit of a personal key is low.
		dirGap:     300 * time.Millisecond,
		dirMaxWait: 3 * time.Second,
	}
}

// SetBaseURL overrides the API base URL (tests).
func (c *Client) SetBaseURL(u string) { c.baseURL = strings.TrimRight(u, "/") }

// BaseURL returns the API base URL.
func (c *Client) BaseURL() string {
	if c == nil {
		return DefaultBaseURL
	}
	return c.baseURL
}

// KeyHint describes the configured key without revealing it.
func (c *Client) KeyHint() netdiag.KeyHint {
	if c == nil {
		return netdiag.Fingerprint("", netdiag.HexKey)
	}
	return netdiag.Fingerprint(c.key, netdiag.HexKey)
}

// Enabled reports whether a key is configured.
func (c *Client) Enabled() bool { return c != nil && c.key != "" }

// available returns nil when calls may be sent: a key is configured and the
// shared breaker is closed. Otherwise it returns the error to report.
func (c *Client) available() error {
	switch {
	case !c.Enabled():
		return ErrUnavailable
	case c.fail.isOpen():
		return c.fail.err()
	}
	return nil
}

// LastError returns the error that paused calls, while they are paused.
func (c *Client) LastError() error {
	if !c.Enabled() || !c.fail.isOpen() {
		return nil
	}
	return c.fail.err()
}

// flexString decodes AMap's habit of returning [] instead of "" for empty
// values; numbers are kept as their text.
type flexString string

func (f *flexString) UnmarshalJSON(b []byte) error {
	if len(b) == 0 {
		*f = ""
		return nil
	}
	switch b[0] {
	case '"':
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*f = flexString(s)
		return nil
	case '[':
		var arr []string
		if err := json.Unmarshal(b, &arr); err == nil && len(arr) > 0 {
			*f = flexString(strings.Join(arr, ""))
			return nil
		}
	case '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
		*f = flexString(b)
		return nil
	}
	*f = ""
	return nil
}

func (f flexString) float() (float64, bool) {
	v, err := strconv.ParseFloat(strings.TrimSpace(string(f)), 64)
	return v, err == nil && !math.IsNaN(v) && !math.IsInf(v, 0)
}

// flexObject decodes a JSON object into V and ignores anything else (AMap
// sends [] for an empty object).
type flexObject[V any] struct{ V V }

func (f *flexObject[V]) UnmarshalJSON(b []byte) error {
	if len(b) > 0 && b[0] == '{' {
		return json.Unmarshal(b, &f.V)
	}
	return nil
}

// flexList decodes a JSON array and ignores anything else ("" or an object).
type flexList[V any] []V

func (f *flexList[V]) UnmarshalJSON(b []byte) error {
	if len(b) > 0 && b[0] == '[' {
		var v []V
		if err := json.Unmarshal(b, &v); err != nil {
			return err
		}
		*f = v
	}
	return nil
}

type baseResp struct {
	Status   flexString `json:"status"`
	Info     flexString `json:"info"`
	Infocode flexString `json:"infocode"`
	// v4 APIs (riding)
	Errcode flexString `json:"errcode"`
	Errmsg  flexString `json:"errmsg"`
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

// netStreak counts the network failures in a row that open the shared
// breaker. A failure counts only when its request started at least gap
// after the last counted one, and after the last answer from AMap or
// breaker change (reset): requests already in flight then say nothing new.
type netStreak struct {
	mu    sync.Mutex
	n     int
	last  time.Time // start of the last counted failed request
	since time.Time // requests started before this do not count
}

// reset restarts the count: AMap answered, or the breaker opened / closed.
func (s *netStreak) reset() {
	s.mu.Lock()
	s.n, s.last, s.since = 0, time.Time{}, time.Now()
	s.mu.Unlock()
}

// fail records a network failure of a request started at start and
// returns the failures in a row and whether this one counted.
func (s *netStreak) fail(start time.Time, gap time.Duration) (int, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if start.Before(s.since) {
		return s.n, false
	}
	if d := start.Sub(s.last); s.n > 0 && d < gap && d > -gap {
		return s.n, false
	}
	s.n++
	s.last = start
	return s.n, true
}

// maxBody bounds the answers read (a POI list is a few tens of KB).
const maxBody = 4 << 20

// fetch sends one request and decodes a successful answer into out, without
// looking at or opening any breaker. Failures are *Error values, except a
// cancelled caller (ErrUnavailable) and results that do not decode.
func (c *Client) fetch(ctx context.Context, path string, q url.Values, out any) error {
	q.Set("key", c.key)
	q.Set("output", "JSON")
	tr := netdiag.NewTrace()
	req, err := http.NewRequestWithContext(tr.Context(ctx), http.MethodGet, c.baseURL+path+"?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	start := time.Now()
	resp, err := c.http.Do(req)
	if err != nil {
		return c.transportError(ctx, err, start, tr, req)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return c.transportError(ctx, err, start, tr, req)
	}
	if resp.StatusCode != http.StatusOK {
		return &Error{HTTPStatus: resp.StatusCode, Info: netdiag.Redact(netdiag.BodySnippet(body, 200), c.key)}
	}
	var br baseResp
	if err := json.Unmarshal(body, &br); err != nil {
		// Not AMap's JSON: a captive portal, or a proxy / WAF page.
		return &Error{BadReply: true, Info: netdiag.Redact(netdiag.BodySnippet(body, 200), c.key)}
	}
	if strings.HasPrefix(path, "/v4/") {
		// The v4 APIs answer {"errcode":0,"errmsg":"OK","data":…}; their
		// error codes are the infocodes of v3.
		if br.Errcode == "" && br.Status == "" {
			return &Error{BadReply: true, Info: netdiag.Redact(netdiag.BodySnippet(body, 200), c.key)}
		}
		if br.Errcode != "" && br.Errcode != "0" {
			return &Error{Infocode: string(br.Errcode), Info: string(br.Errmsg)}
		}
	} else if br.Status != "1" {
		return &Error{Infocode: string(br.Infocode), Info: string(br.Info)}
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("amap decode: %w", err) // AMap's JSON, in a shape this client does not know
	}
	return nil
}

// transportError explains a failure to send a request or read its answer.
// The caller going away is not an AMap failure (ErrUnavailable). When the
// caller's own deadline, shorter than the client's timeout, ended the
// request, the *Error is marked cut: AMap was not given the time a request
// may take, so it does not count towards pausing AMap.
func (c *Client) transportError(ctx context.Context, err error, start time.Time, tr *netdiag.Trace, req *http.Request) error {
	if errors.Is(ctx.Err(), context.Canceled) {
		// The caller went away (browser abort, client disconnect).
		return fmt.Errorf("%w: %v", ErrUnavailable, ctx.Err())
	}
	// The text drops the URL's query and never contains the key.
	e := &Error{Network: true, Info: netdiag.ErrorText(err, c.key), Host: hostOf(c.baseURL),
		Net: netdiag.Classify(err, tr, netdiag.ProxyOf(c.http, req))}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		dl, ok := ctx.Deadline()
		e.cut = ok && c.http.Timeout > 0 && dl.Sub(start) < c.http.Timeout*4/5
	}
	return e
}

func (c *Client) get(ctx context.Context, path string, q url.Values, out any) error {
	return c.getWith(ctx, &c.fail, path, q, out)
}

// getWith is get for an API with a quota of its own: its key and quota
// errors open breaker instead of the shared one. Network errors still open
// the shared breaker.
//
// Network failures (HTTP error statuses and answers that are not AMap's
// JSON too) open the shared breaker for netPause after netFailLimit of them
// in a row (see netStreak); any answer from AMap resets the count, and a
// request cut short by its caller's deadline does not count. Key and quota
// errors open the breaker (pausing its calls) for 10 minutes. Other API
// errors only fail this request: QPS limits pass by themselves, and
// per-request errors (2xxxx / 3xxxx, e.g. 20012 for a keyword with illegal
// content) must not let crafted input disable AMap for everyone.
func (c *Client) getWith(ctx context.Context, b *breaker, path string, q url.Values, out any) error {
	if err := c.available(); err != nil {
		return err
	}
	if b.isOpen() {
		return b.err()
	}
	start := time.Now()
	err := c.fetch(ctx, path, q, out)
	var e *Error
	if !errors.As(err, &e) {
		if err == nil {
			c.streak.reset() // AMap answered
		}
		return err
	}
	switch {
	case e.cut:
		if c.warnAllowed() {
			slog.Warn("amap request cut short by the caller's deadline", "path", path, "layer", e.Layer(), "err", e.Info)
		}
	case e.Network || e.HTTPStatus != 0 || e.BadReply:
		n, counted := c.streak.fail(start, c.netGap)
		if n < netFailLimit || !counted {
			slog.Warn("amap request failed", "path", path, "layer", e.Layer(), "status", e.HTTPStatus, "err", e.Info,
				"consecutive", n, "counted", counted)
			break
		}
		// Unreachable for a while: fail fast instead of making every user wait.
		c.fail.open(netPause, e)
		c.streak.reset()
		slog.Warn("高德连续多次请求失败，暂停调用 20 秒", "path", path, "consecutive", n, "layer", e.Layer(),
			"status", e.HTTPStatus, "err", e.Info, "hint", e.Message())
	case keyErrors[e.Infocode]:
		c.streak.reset() // AMap answered
		b.open(10*time.Minute, e)
		c.lastWarn.Store(time.Now().UnixNano())
		slog.Warn("高德 Key 无效或调用额度已用尽，暂停调用 10 分钟", "path", path, "infocode", e.Infocode, "info", e.Info,
			"hint", e.Message())
	case qpsErrors[e.Infocode]:
		c.streak.reset()
		if c.warnAllowed() {
			slog.Warn("高德接口调用超出 QPS 限制", "path", path, "infocode", e.Infocode, "info", e.Info)
		}
	default:
		c.streak.reset()
		if c.warnAllowed() {
			slog.Warn("高德接口返回错误", "path", path, "infocode", e.Infocode, "info", e.Info)
		}
	}
	return err
}

// Check sends a live keyword search (天安门 in 北京), bypassing the caches
// and the breaker, for the admin diagnostics. A success closes the shared
// breaker.
func (c *Client) Check(ctx context.Context) error {
	if !c.Enabled() {
		return ErrUnavailable
	}
	q := url.Values{}
	q.Set("keywords", "天安门")
	q.Set("city", "北京")
	q.Set("offset", "1")
	q.Set("page", "1")
	q.Set("extensions", "base")
	var resp struct {
		Pois flexList[poiJSON] `json:"pois"`
	}
	if err := c.fetch(ctx, "/v3/place/text", q, &resp); err != nil {
		return err
	}
	c.fail.close()
	c.streak.reset()
	return nil
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
	Adcode   string // the district's code ("331002"), when AMap sends it
	Lng, Lat float64
	Distance float64 // metres, only for around-search and reverse geocoding
	Rating   float64 // AMap's business rating (0–5), 0 if unknown (Find only)
	Cost     float64 // AMap's average cost per person in yuan, 0 if unknown (Find only)
}

type poiJSON struct {
	ID       flexString `json:"id"`
	Name     flexString `json:"name"`
	Type     flexString `json:"type"`
	Typecode flexString `json:"typecode"`
	Address  flexString `json:"address"`
	Location flexString `json:"location"`
	Pname    flexString `json:"pname"`
	Cityname flexString `json:"cityname"`
	Adname   flexString `json:"adname"`
	Adcode   flexString `json:"adcode"`
	Tel      flexString `json:"tel"`
	Distance flexString `json:"distance"`
	BizExt   flexObject[struct {
		Rating flexString `json:"rating"`
		Cost   flexString `json:"cost"`
	}] `json:"biz_ext"`
}

func (p poiJSON) toPOI() (POI, bool) {
	lng, lat, ok := parseLocation(string(p.Location))
	if !ok || strings.TrimSpace(string(p.Name)) == "" {
		return POI{}, false
	}
	city := string(p.Cityname)
	if city == "" {
		city = string(p.Pname)
	}
	out := POI{
		ID: string(p.ID), Name: string(p.Name), Address: string(p.Address),
		Province: string(p.Pname), City: city, District: string(p.Adname),
		Type: string(p.Type), Category: Category(string(p.Type)), Tel: string(p.Tel), Adcode: string(p.Adcode),
		Lng: lng, Lat: lat,
	}
	if out.Type == "" && p.Typecode != "" {
		out.Category = CategoryFromTypecode(string(p.Typecode))
	}
	if d, ok := p.Distance.float(); ok {
		out.Distance = d
	}
	if v, ok := p.BizExt.V.Rating.float(); ok && v > 0 && v <= 5 {
		out.Rating = v
	}
	if v, ok := p.BizExt.V.Cost.float(); ok && v > 0 {
		out.Cost = v
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
	if err1 != nil || err2 != nil || lng < -180 || lng > 180 || lat < -90 || lat > 90 {
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
		Pois flexList[poiJSON] `json:"pois"`
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
		Pois flexList[poiJSON] `json:"pois"`
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
		Pois flexList[poiJSON] `json:"pois"`
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

type addressComponentJSON struct {
	Province     flexString `json:"province"`
	City         flexString `json:"city"`
	District     flexString `json:"district"`
	Township     flexString `json:"township"`
	Adcode       flexString `json:"adcode"`
	StreetNumber flexObject[struct {
		Street flexString `json:"street"`
		Number flexString `json:"number"`
	}] `json:"streetNumber"`
}

// IsCountry reports whether s names the whole country: AMap answers
// "中华人民共和国" (adcode 100000) as the province and address of points in
// the sea, which must not be taken for a place.
func IsCountry(s string) bool {
	switch strings.TrimSpace(s) {
	case "中华人民共和国", "中国", "China", "People's Republic of China":
		return true
	}
	return false
}

func (ac addressComponentJSON) regeo(formatted flexString) Regeo {
	r := Regeo{
		Province: string(ac.Province), City: string(ac.City), District: string(ac.District),
		Township: string(ac.Township), FormattedAddress: string(formatted), Adcode: string(ac.Adcode),
	}
	if IsCountry(r.Province) || r.Adcode == "100000" {
		// No province (a point in the sea): callers fall back to the atlas.
		r.Province, r.Adcode = "", ""
		if IsCountry(r.City) {
			r.City = ""
		}
	}
	if IsCountry(r.FormattedAddress) {
		r.FormattedAddress = ""
	}
	if r.City == "" {
		r.City = r.Province // municipalities
	}
	return r
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
		Regeocode flexObject[struct {
			FormattedAddress flexString                       `json:"formatted_address"`
			AddressComponent flexObject[addressComponentJSON] `json:"addressComponent"`
		}] `json:"regeocode"`
	}
	if err := c.get(ctx, "/v3/geocode/regeo", q, &resp); err != nil {
		return nil, err
	}
	rc := resp.Regeocode.V
	r := rc.AddressComponent.V.regeo(rc.FormattedAddress)
	c.regeo.Put(key, &r)
	return &r, nil
}

// AOI is an area of interest from reverse geocoding: a scenic area, campus,
// mall, residential compound… Coordinates are GCJ-02.
type AOI struct {
	ID        string
	Name      string
	Typecode  string
	Category  string
	Lng, Lat  float64
	AreaM2    float64
	DistanceM float64 // 0: the point is inside the AOI
}

// RegeoDetail is a reverse-geocoding result with the areas and places
// around the point.
type RegeoDetail struct {
	Regeo
	Street string // street of the nearest door number
	Number string // the door number
	Road   string // nearest road
	AOIs   []AOI  // as AMap orders them
	POIs   []POI  // within 200 m, with Distance
}

// Spot returns the name of the place at the point, for naming it: the
// (smallest) AOI containing the point, else the nearest POI within maxPOI
// metres; "" when there is none.
func (r *RegeoDetail) Spot(maxPOI float64) string {
	best := -1
	for i, a := range r.AOIs {
		if a.DistanceM <= 0 && (best < 0 || (a.AreaM2 > 0 && a.AreaM2 < r.AOIs[best].AreaM2)) {
			best = i
		}
	}
	if best >= 0 {
		return r.AOIs[best].Name
	}
	name, nearest := "", maxPOI
	for _, p := range r.POIs {
		if p.Distance <= nearest {
			name, nearest = p.Name, p.Distance
		}
	}
	return name
}

// Max numbers of AOIs / POIs kept per RegeoDetail (they are cached).
const (
	maxDetailAOIs = 6
	maxDetailPOIs = 15
)

// RegeoDetail reverse-geocodes a GCJ-02 point with extensions=all (AOIs,
// POIs and roads within 200 m); results are cached for a day and shared
// (must not be modified).
func (c *Client) RegeoDetail(ctx context.Context, lng, lat float64) (*RegeoDetail, error) {
	key := fmt.Sprintf("%.5f,%.5f", lng, lat)
	if r, ok := c.detail.Get(key); ok {
		return r, nil
	}
	q := url.Values{}
	q.Set("location", fmt.Sprintf("%.6f,%.6f", lng, lat))
	q.Set("extensions", "all")
	q.Set("radius", "200")
	q.Set("roadlevel", "0")
	var resp struct {
		Regeocode flexObject[struct {
			FormattedAddress flexString                       `json:"formatted_address"`
			AddressComponent flexObject[addressComponentJSON] `json:"addressComponent"`
			Pois             flexList[poiJSON]                `json:"pois"`
			Roads            flexList[struct {
				Name     flexString `json:"name"`
				Distance flexString `json:"distance"`
			}] `json:"roads"`
			Aois flexList[struct {
				ID       flexString `json:"id"`
				Name     flexString `json:"name"`
				Location flexString `json:"location"`
				Area     flexString `json:"area"`
				Distance flexString `json:"distance"`
				Type     flexString `json:"type"`
			}] `json:"aois"`
		}] `json:"regeocode"`
	}
	if err := c.get(ctx, "/v3/geocode/regeo", q, &resp); err != nil {
		return nil, err
	}
	rc := resp.Regeocode.V
	ac := rc.AddressComponent.V
	out := &RegeoDetail{Regeo: ac.regeo(rc.FormattedAddress),
		Street: string(ac.StreetNumber.V.Street), Number: string(ac.StreetNumber.V.Number)}
	roadDist := math.Inf(1)
	for _, r := range rc.Roads {
		if d, ok := r.Distance.float(); ok && d < roadDist && r.Name != "" {
			out.Road, roadDist = string(r.Name), d
		}
	}
	for _, a := range rc.Aois {
		alng, alat, ok := parseLocation(string(a.Location))
		if !ok || strings.TrimSpace(string(a.Name)) == "" || len(out.AOIs) >= maxDetailAOIs {
			continue
		}
		area, _ := a.Area.float()
		dist, ok := a.Distance.float()
		if !ok { // not given: never take the point for inside
			dist = math.Max(1, geo.Haversine(lng, lat, alng, alat))
		}
		out.AOIs = append(out.AOIs, AOI{ID: string(a.ID), Name: string(a.Name), Typecode: string(a.Type),
			Category: CategoryFromTypecode(string(a.Type)), Lng: alng, Lat: alat, AreaM2: area, DistanceM: dist})
	}
	for _, p := range convertPOIs(rc.Pois) {
		if len(out.POIs) >= maxDetailPOIs {
			break
		}
		// Regeo POIs carry no province / city of their own: they are the point's.
		p.Province, p.City = out.Province, out.City
		if p.District == "" {
			p.District = out.District
		}
		out.POIs = append(out.POIs, p)
	}
	c.detail.Put(key, out)
	return out, nil
}

// Route is a 路径规划 result.
type Route struct {
	Mode      string // walking, riding, transit or driving
	DistanceM int
	DurationS int
	// path is the simplified route (GCJ-02) as lng, lat pairs in units of
	// 1e-5 degrees (compact: routes are cached); nil when AMap sent none.
	path []int32
}

// Polyline returns the route as [[lng, lat], …] (GCJ-02, 5 decimals),
// simplified with Douglas-Peucker (see simplifyTolerance), from the start to
// the end point of the request; nil when AMap sent no geometry.
func (r *Route) Polyline() [][2]float64 {
	if r == nil || len(r.path) < 4 {
		return nil
	}
	out := make([][2]float64, len(r.path)/2)
	for i := range out {
		out[i] = [2]float64{float64(r.path[2*i]) / 1e5, float64(r.path[2*i+1]) / 1e5}
	}
	return out
}

// DirectionModes are the modes of Direction.
var DirectionModes = []string{"walking", "riding", "driving", "transit"}

// dirStep / dirPath are the paths of walking, riding and driving answers.
type dirStep struct {
	Polyline flexString `json:"polyline"`
}

type dirPath struct {
	Distance flexString        `json:"distance"`
	Duration flexString        `json:"duration"`
	Steps    flexList[dirStep] `json:"steps"`
}

// stopJSON is a station of a public transport answer.
type stopJSON struct {
	Location flexString `json:"location"`
}

// transitJSON is one public transport plan: its walking, bus / metro and
// railway segments in order.
type transitJSON struct {
	Distance flexString `json:"distance"`
	Duration flexString `json:"duration"`
	Segments flexList[struct {
		Walking flexObject[struct {
			Steps flexList[dirStep] `json:"steps"`
		}] `json:"walking"`
		Bus flexObject[struct {
			Buslines flexList[struct {
				Polyline flexString `json:"polyline"`
			}] `json:"buslines"`
		}] `json:"bus"`
		Railway flexObject[struct {
			DepartureStop flexObject[stopJSON] `json:"departure_stop"`
			ViaStops      flexList[stopJSON]   `json:"via_stops"`
			ArrivalStop   flexObject[stopJSON] `json:"arrival_stop"`
		}] `json:"railway"`
	}] `json:"segments"`
}

// points returns the transit plan's way: its walks and the lines of its
// buses / metro in order; trains, whose track AMap does not send, go
// straight from station to station.
func (t *transitJSON) points() []geo.Point {
	var pts []geo.Point
	for _, seg := range t.Segments {
		for _, st := range seg.Walking.V.Steps {
			pts = appendPolyline(pts, string(st.Polyline))
		}
		if lines := seg.Bus.V.Buslines; len(lines) > 0 {
			pts = appendPolyline(pts, string(lines[0].Polyline))
		}
		rw := seg.Railway.V
		pts = appendPolyline(pts, string(rw.DepartureStop.V.Location))
		for _, v := range rw.ViaStops {
			pts = appendPolyline(pts, string(v.Location))
		}
		pts = appendPolyline(pts, string(rw.ArrivalStop.V.Location))
	}
	return pts
}

// appendPolyline appends the points of an AMap polyline ("lng,lat;lng,lat")
// to pts, skipping repeated points and invalid pairs.
func appendPolyline(pts []geo.Point, s string) []geo.Point {
	for _, pair := range strings.Split(s, ";") {
		lng, lat, ok := parseLocation(pair)
		if !ok {
			continue
		}
		if n := len(pts); n > 0 && pts[n-1].Lng == lng && pts[n-1].Lat == lat {
			continue
		}
		pts = append(pts, geo.Point{Lng: lng, Lat: lat})
	}
	return pts
}

// simplifyTolerance is the Douglas-Peucker tolerance (metres) of a route
// whose ends are straight metres apart: 20 m, coarser for long routes (a
// highway drive of hundreds of kilometres needs no 20 m detail).
func simplifyTolerance(straight float64) float64 { return math.Max(20, straight/1500) }

// compactPath simplifies a route from (fromLng, fromLat) to (toLng, toLat)
// through pts and packs it (see Route.path); the request's end points are
// its first and last points, so that it meets the markers of both stops.
func compactPath(pts []geo.Point, fromLng, fromLat, toLng, toLat float64) []int32 {
	if len(pts) == 0 {
		return nil
	}
	all := make([]geo.Point, 0, len(pts)+2)
	all = append(all, geo.Point{Lng: fromLng, Lat: fromLat})
	all = append(all, pts...)
	all = append(all, geo.Point{Lng: toLng, Lat: toLat})
	all = geo.Simplify(all, simplifyTolerance(geo.Haversine(fromLng, fromLat, toLng, toLat)))
	out := make([]int32, 0, 2*len(all))
	for _, p := range all {
		x, y := int32(math.Round(p.Lng*1e5)), int32(math.Round(p.Lat*1e5))
		if n := len(out); n >= 2 && out[n-2] == x && out[n-1] == y {
			continue
		}
		out = append(out, x, y)
	}
	return out
}

// directionKey is the cache key of a Direction request.
func directionKey(mode string, fromLng, fromLat, toLng, toLat float64, city, cityd string) string {
	return fmt.Sprintf("%s|%.5f,%.5f|%.5f,%.5f|%s|%s", mode, fromLng, fromLat, toLng, toLat, city, cityd)
}

// CachedDirection returns a route Direction planned recently (never sending
// a request).
func (c *Client) CachedDirection(mode string, fromLng, fromLat, toLng, toLat float64, city, cityd string) (*Route, bool) {
	if c == nil || c.dir == nil {
		return nil, false
	}
	return c.dir.Get(directionKey(mode, fromLng, fromLat, toLng, toLat, city, cityd))
}

// Direction plans a trip between two GCJ-02 points. mode is "walking"
// (/v3/direction/walking), "riding" (/v4/direction/bicycling), "driving"
// (/v3/direction/driving) or "transit" (/v3/direction/transit/integrated:
// city and cityd are the city names of both ends; ErrNoRoute when AMap has
// no public transport between them). The route's way is kept simplified
// (see Route.Polyline). Successful results are cached for 7 days (the
// returned Route is shared and must not be modified); requests are
// throttled (see throttle).
func (c *Client) Direction(ctx context.Context, mode string, fromLng, fromLat, toLng, toLat float64, city, cityd string) (*Route, error) {
	q := url.Values{}
	var path string
	switch mode {
	case "walking":
		path = "/v3/direction/walking"
	case "riding":
		path = "/v4/direction/bicycling"
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
	key := directionKey(mode, fromLng, fromLat, toLng, toLat, city, cityd)
	if r, ok := c.dir.Get(key); ok {
		return r, nil
	}
	if err := c.available(); err != nil {
		return nil, err
	}
	if c.dirFail.isOpen() {
		return nil, c.dirFail.err()
	}
	if err := c.throttle(ctx); err != nil {
		return nil, err
	}
	q.Set("origin", fmt.Sprintf("%.6f,%.6f", fromLng, fromLat))
	q.Set("destination", fmt.Sprintf("%.6f,%.6f", toLng, toLat))
	var resp struct {
		Route flexObject[struct {
			Distance flexString            `json:"distance"`
			Paths    flexList[dirPath]     `json:"paths"`
			Transits flexList[transitJSON] `json:"transits"`
		}] `json:"route"`
		// Riding (/v4) answers {"errcode":0,"data":{"paths":[…]}}.
		Data flexObject[struct {
			Paths flexList[dirPath] `json:"paths"`
		}] `json:"data"`
	}
	if err := c.getWith(ctx, &c.dirFail, path, q, &resp); err != nil {
		return nil, err
	}
	route := resp.Route.V
	var dist, dur flexString
	var pts []geo.Point
	switch {
	case mode == "transit":
		if len(route.Transits) == 0 {
			return nil, ErrNoRoute
		}
		t := &route.Transits[0]
		dist, dur, pts = t.Distance, t.Duration, t.points()
		if _, ok := roundNumber(dist); !ok {
			dist = route.Distance
		}
	default:
		paths := route.Paths
		if mode == "riding" {
			paths = resp.Data.V.Paths
		}
		if len(paths) == 0 {
			return nil, ErrNoRoute
		}
		p := &paths[0]
		dist, dur = p.Distance, p.Duration
		for _, st := range p.Steps {
			pts = appendPolyline(pts, string(st.Polyline))
		}
	}
	d, okDist := roundNumber(dist)
	s, okDur := roundNumber(dur)
	if !okDist || !okDur {
		return nil, ErrNoRoute
	}
	r := &Route{Mode: mode, DistanceM: d, DurationS: s, path: compactPath(pts, fromLng, fromLat, toLng, toLat)}
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
		return ErrBusy
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

// CategoryFromTypecode maps an AMap type code ("050100", or several joined
// by "|") to a TripHub category, like Category does for type names.
func CategoryFromTypecode(code string) string {
	code, _, _ = strings.Cut(strings.TrimSpace(code), "|")
	if len(code) < 4 {
		return "other"
	}
	switch code[:2] {
	case "05":
		return "food"
	case "10":
		return "hotel"
	case "11":
		return "scenic" // 风景名胜 (incl. 公园广场)
	case "06":
		return "shopping"
	case "15":
		return "transport"
	case "08":
		return "entertainment" // 体育休闲服务
	case "14":
		if code[:4] == "1401" { // 博物馆
			return "scenic"
		}
	}
	return "other"
}
