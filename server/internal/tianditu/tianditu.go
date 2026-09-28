// Package tianditu is a small client for the 天地图 (Tianditu) web services
// (https://lbs.tianditu.gov.cn/server/guide.html): place search V2.0
// (/v2/search) and reverse geocoding (/geocoder). It is an optional free
// fallback for AMap and needs a 「服务端」 key (tk).
//
// Tianditu uses CGCS2000 coordinates (≈ WGS-84 at the centimetre level);
// this package takes and returns GCJ-02 like the rest of TripHub.
//
// The response formats are implemented from the public documentation and
// SDKs, and parsed tolerantly (numbers or strings, objects or arrays), since
// the service is not reachable from every test environment. Like package
// amap it degrades gracefully: failures return an *Error quickly and callers
// fall back to other sources.
package tianditu

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"triphub/internal/geo"
	"triphub/internal/lru"
)

// DefaultBaseURL is the Tianditu web service endpoint.
const DefaultBaseURL = "https://api.tianditu.gov.cn"

// ErrUnavailable means the service is not configured or temporarily paused.
var ErrUnavailable = errors.New("tianditu unavailable")

// chinaBound is the map bound of a nationwide search (minLng,minLat,maxLng,maxLat).
const chinaBound = "73.0,3.0,136.0,54.0"

// Client talks to the Tianditu web services.
type Client struct {
	key     string
	baseURL string
	http    *http.Client
	search  *lru.Cache[[]POI]
	regeo   *lru.Cache[*Regeo]

	failUntil atomic.Int64 // unix nanos: calls paused after key / network errors
	lastErr   atomic.Pointer[Error]
	lastWarn  atomic.Int64
}

// New creates a client. An empty key yields a disabled client.
func New(key string) *Client {
	return &Client{
		key:     strings.TrimSpace(key),
		baseURL: DefaultBaseURL,
		http:    &http.Client{Timeout: 5 * time.Second},
		search:  lru.New[[]POI](2000, 30*time.Minute),
		regeo:   lru.New[*Regeo](10000, 24*time.Hour),
	}
}

// SetBaseURL overrides the API base URL (tests).
func (c *Client) SetBaseURL(u string) { c.baseURL = strings.TrimRight(u, "/") }

// Enabled reports whether a key is configured.
func (c *Client) Enabled() bool { return c != nil && c.key != "" }

func (c *Client) available() error {
	if !c.Enabled() {
		return ErrUnavailable
	}
	if time.Now().UnixNano() < c.failUntil.Load() {
		if last := c.lastErr.Load(); last != nil {
			cp := *last
			cp.Paused = true
			return &cp
		}
		return ErrUnavailable
	}
	return nil
}

func (c *Client) pause(d time.Duration, e *Error) {
	c.lastErr.Store(e)
	c.failUntil.Store(time.Now().Add(d).UnixNano())
}

// Error is a failed Tianditu call. It wraps ErrUnavailable.
type Error struct {
	HTTPStatus int
	Code       string // Tianditu's code / infocode / status, if any
	Msg        string // Tianditu's msg / cndesc, or the network error
	Resolve    string // Tianditu's suggested fix, if any
	Network    bool
	Host       string
	Paused     bool // not sent: an earlier failure (this one) paused calls
}

func (e *Error) Error() string {
	s := "tianditu"
	if e.Paused {
		s += " paused after"
	}
	if e.HTTPStatus != 0 {
		s += fmt.Sprintf(" http %d", e.HTTPStatus)
	}
	if e.Code != "" {
		s += " code " + e.Code
	}
	if e.Msg != "" {
		s += ": " + e.Msg
	}
	return s
}

func (e *Error) Unwrap() error { return ErrUnavailable }

// keyError reports errors that every request would get (wrong / invalid
// key, key type or whitelist, quota): they pause calls for 10 minutes.
func (e *Error) keyError() bool {
	if e.HTTPStatus == http.StatusUnauthorized || e.HTTPStatus == http.StatusForbidden || e.HTTPStatus == http.StatusTooManyRequests {
		return true
	}
	switch e.Code {
	case "12", "18", "301001", "301002", "302010":
		return true
	}
	for _, s := range []string{"权限", "key", "Key", "KEY", "限流", "白名单", "域名"} {
		if strings.Contains(e.Msg, s) {
			return true
		}
	}
	return false
}

// Message explains the failure in Chinese, with what the operator can do.
func (e *Error) Message() string {
	msg := e.message()
	if e.Paused {
		msg += "（已暂停调用天地图，稍后自动重试）"
	}
	return msg
}

func (e *Error) message() string {
	text := e.Msg + " " + e.Resolve
	switch {
	case e.Network:
		host := e.Host
		if host == "" {
			host = "api.tianditu.gov.cn"
		}
		return "服务器无法连接天地图（" + host + "）"
	case e.Code == "12" || e.Code == "18" || strings.Contains(text, "权限类型") || strings.Contains(text, "key类型") ||
		strings.Contains(text, "浏览器端"):
		return "天地图 Key 类型不对：请在天地图控制台为本站创建「服务端」类型的 Key"
	case e.Code == "302010" || e.HTTPStatus == http.StatusTooManyRequests || strings.Contains(text, "限流"):
		return "天地图 Key 已被限流（超出调用额度），请稍后再试"
	case strings.Contains(text, "IP") || strings.Contains(text, "白名单"):
		return "服务器 IP 不在天地图 Key 的白名单中"
	case strings.Contains(text, "域名"):
		return "天地图 Key 限定了域名（浏览器端 Key），请改用「服务端」类型的 Key"
	case e.Code == "301001" || e.Code == "301002" || strings.Contains(text, "非法") || strings.Contains(text, "无效") ||
		e.HTTPStatus == http.StatusUnauthorized || e.HTTPStatus == http.StatusForbidden:
		return "天地图 Key 无效，请检查 .env 中的 TIANDITU_KEY" + detail(e.Msg, e.Resolve)
	case e.HTTPStatus != 0:
		return fmt.Sprintf("天地图接口返回 HTTP %d", e.HTTPStatus) + detail(e.Msg, e.Resolve)
	}
	return "天地图接口返回错误" + detail(e.Msg, e.Resolve)
}

func detail(msg, resolve string) string {
	parts := []string{}
	for _, s := range []string{msg, resolve} {
		if s = strings.TrimSpace(s); s != "" {
			parts = append(parts, s)
		}
	}
	if len(parts) == 0 {
		return ""
	}
	return "（" + strings.Join(parts, "；") + "）"
}

// ErrorMessage explains an error returned by this package in Chinese; ""
// when there is nothing to report (no key configured, caller cancelled).
func ErrorMessage(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Message()
	}
	return ""
}

// flex decodes a JSON string, number or bool as text; anything else is "".
type flex string

func (f *flex) UnmarshalJSON(b []byte) error {
	*f = ""
	if len(b) == 0 {
		return nil
	}
	switch b[0] {
	case '"':
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*f = flex(s)
	case '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 't', 'f':
		if string(b) != "null" {
			*f = flex(b)
		}
	}
	return nil
}

func (f flex) float() (float64, bool) {
	s := strings.TrimSpace(string(f))
	mult := 1.0
	switch {
	case strings.HasSuffix(s, "km"), strings.HasSuffix(s, "公里"), strings.HasSuffix(s, "千米"):
		mult = 1000
	}
	s = strings.TrimRight(s, "kmKM公里千米米")
	v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return v * mult, err == nil
}

// list decodes a JSON array of V, or a single object as a one-item list;
// anything else is empty.
type list[V any] []V

func (l *list[V]) UnmarshalJSON(b []byte) error {
	*l = nil
	if len(b) == 0 {
		return nil
	}
	switch b[0] {
	case '[':
		var v []V
		if err := json.Unmarshal(b, &v); err == nil {
			*l = v
		}
	case '{':
		var v V
		if err := json.Unmarshal(b, &v); err == nil {
			*l = []V{v}
		}
	}
	return nil
}

// apiErrorBody is the error answer of the gateway, e.g.
// {"msg":"权限类型错误","resolve":"key权限为浏览器端，请使用浏览器访问","code":"12"}.
type apiErrorBody struct {
	Msg     flex `json:"msg"`
	Message flex `json:"message"`
	Resolve flex `json:"resolve"`
	Code    flex `json:"code"`
}

// fetch sends GET {base}{path}?postStr=…&type=…&tk=… and returns the body
// of a 200 answer. It does not look at or open the breaker.
func (c *Client) fetch(ctx context.Context, path string, q url.Values) ([]byte, error) {
	q.Set("tk", c.key)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path+"?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	// The gateway rejects some default client user agents.
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; TripHub)")
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return nil, fmt.Errorf("%w: %v", ErrUnavailable, ctx.Err())
		}
		msg := strings.ReplaceAll(err.Error(), c.key, "***")
		return nil, &Error{Network: true, Msg: msg, Host: hostOf(c.baseURL)}
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, &Error{Network: true, Msg: err.Error(), Host: hostOf(c.baseURL)}
	}
	var eb apiErrorBody
	_ = json.Unmarshal(data, &eb)
	msg := string(eb.Msg)
	if msg == "" {
		msg = string(eb.Message)
	}
	if resp.StatusCode != http.StatusOK {
		if msg == "" {
			msg = strings.TrimSpace(string(data))
			if len(msg) > 200 {
				msg = msg[:200]
			}
		}
		return nil, &Error{HTTPStatus: resp.StatusCode, Code: string(eb.Code), Msg: msg, Resolve: string(eb.Resolve)}
	}
	// A gateway error with status 200, e.g. {"code":302010,"msg":"该tk已限流"}.
	if msg != "" && eb.Code != "" && !hasAnyKey(data, "pois", "result", "status", "area", "statistics") {
		return nil, &Error{Code: string(eb.Code), Msg: msg, Resolve: string(eb.Resolve)}
	}
	return data, nil
}

func hasAnyKey(data []byte, keys ...string) bool {
	var m map[string]json.RawMessage
	if json.Unmarshal(data, &m) != nil {
		return false
	}
	for _, k := range keys {
		if _, ok := m[k]; ok {
			return true
		}
	}
	return false
}

// get is fetch behind the breaker: key errors pause calls for 10 minutes,
// network errors for a minute, server errors for 30 seconds.
func (c *Client) get(ctx context.Context, path string, q url.Values) ([]byte, error) {
	if err := c.available(); err != nil {
		return nil, err
	}
	data, err := c.fetch(ctx, path, q)
	var e *Error
	if errors.As(err, &e) {
		switch {
		case e.Network:
			c.pause(time.Minute, e)
			slog.Warn("tianditu request failed, disabling for 60s", "path", path, "err", e.Msg)
		case e.keyError():
			c.pause(10*time.Minute, e)
			slog.Warn("天地图 Key 无效或调用受限，暂停调用 10 分钟", "path", path, "err", e.Error(), "hint", e.Message())
		case e.HTTPStatus >= 500:
			c.pause(30*time.Second, e)
			slog.Warn("tianditu returned an error status, disabling for 30s", "path", path, "status", e.HTTPStatus)
		default:
			now := time.Now().UnixNano()
			if last := c.lastWarn.Load(); now-last >= int64(time.Minute) && c.lastWarn.CompareAndSwap(last, now) {
				slog.Warn("天地图接口返回错误", "path", path, "err", e.Error())
			}
		}
	}
	return data, err
}

func hostOf(base string) string {
	if u, err := url.Parse(base); err == nil && u.Host != "" {
		return u.Host
	}
	return base
}

// POI is a search result. Coordinates are GCJ-02.
type POI struct {
	ID       string // hotPointID
	Name     string
	Address  string
	Province string
	City     string
	District string
	Type     string // typeName, e.g. "中餐馆"
	Category string // TripHub category
	Tel      string
	Lng, Lat float64
}

type poiJSON struct {
	Name       flex `json:"name"`
	Address    flex `json:"address"`
	Lonlat     flex `json:"lonlat"`
	HotPointID flex `json:"hotPointID"`
	Phone      flex `json:"phone"`
	Province   flex `json:"province"`
	City       flex `json:"city"`
	County     flex `json:"county"`
	TypeName   flex `json:"typeName"`
	PoiType    flex `json:"poiType"`
}

type areaJSON struct {
	Name      flex `json:"name"`
	Lonlat    flex `json:"lonlat"`
	AdminCode flex `json:"adminCode"`
}

type searchResp struct {
	ResultType flex           `json:"resultType"`
	Pois       list[poiJSON]  `json:"pois"`
	Area       list[areaJSON] `json:"area"`
	Statistics list[struct {
		PriorityCitys list[areaJSON] `json:"priorityCitys"`
		AllAdmins     list[areaJSON] `json:"allAdmins"`
	}] `json:"statistics"`
	Status struct {
		Infocode flex `json:"infocode"`
		Cndesc   flex `json:"cndesc"`
	} `json:"status"`
}

// parseLonlat reads "lng,lat" (or "lng lat") in CGCS2000 and returns GCJ-02.
func parseLonlat(s string) (float64, float64, bool) {
	f := strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ' ' || r == ';' })
	if len(f) < 2 {
		return 0, 0, false
	}
	lng, err1 := strconv.ParseFloat(f[0], 64)
	lat, err2 := strconv.ParseFloat(f[1], 64)
	if err1 != nil || err2 != nil || !geo.ValidCoord(lng, lat) || (lng == 0 && lat == 0) {
		return 0, 0, false
	}
	lng, lat = geo.WGS84ToGCJ02(lng, lat)
	return geo.Round(lng, 6), geo.Round(lat, 6), true
}

func (p poiJSON) toPOI() (POI, bool) {
	name := strings.TrimSpace(string(p.Name))
	lng, lat, ok := parseLonlat(string(p.Lonlat))
	if !ok || name == "" || string(p.PoiType) == "102" { // 102: bus stop (with line data)
		return POI{}, false
	}
	city := string(p.City)
	if city == "" {
		city = string(p.Province)
	}
	return POI{ID: string(p.HotPointID), Name: name, Address: string(p.Address), Province: string(p.Province),
		City: city, District: string(p.County), Type: string(p.TypeName), Category: Category(string(p.TypeName)),
		Tel: string(p.Phone), Lng: lng, Lat: lat}, true
}

// SearchHint narrows a search to where the user is looking.
type SearchHint struct {
	AdminCode string // 6-digit code of a city or province (offline atlas), preferred
	City      string // a city name, used when no code is known
}

func specifyOf(code string) string {
	code = strings.TrimSpace(code)
	if len(code) == 6 {
		return "156" + code
	}
	return code
}

// Search finds places by keyword: first within the hinted region
// (行政区划区域搜索, queryType 12), then nationwide (普通搜索, queryType 1).
// A nationwide answer with statistics per region instead of places is
// followed into the first region. Results are cached for 30 minutes; the
// returned slice is shared and must not be modified.
func (c *Client) Search(ctx context.Context, keyword string, hint SearchHint, limit int) ([]POI, error) {
	keyword = strings.TrimSpace(keyword)
	if limit <= 0 || limit > 20 {
		limit = 20
	}
	specify := specifyOf(hint.AdminCode)
	if specify == "" {
		specify = strings.TrimSpace(hint.City)
	}
	key := fmt.Sprintf("%s\x00%s\x00%d", keyword, specify, limit)
	if ps, ok := c.search.Get(key); ok {
		return ps, nil
	}
	if err := c.available(); err != nil {
		return nil, err
	}
	var pois []POI
	if specify != "" {
		ps, _, err := c.query(ctx, map[string]any{"keyWord": keyword, "queryType": 12, "specify": specify, "start": 0, "count": limit})
		if err != nil {
			return nil, err
		}
		pois = ps
	}
	if len(pois) == 0 {
		ps, region, err := c.query(ctx, map[string]any{"keyWord": keyword, "queryType": 1, "mapBound": chinaBound, "level": 12,
			"start": 0, "count": limit})
		if err != nil {
			return nil, err
		}
		pois = ps
		if len(pois) == 0 && region != "" && region != specify {
			if ps, _, err := c.query(ctx, map[string]any{"keyWord": keyword, "queryType": 12, "specify": region, "start": 0, "count": limit}); err == nil {
				pois = ps
			}
		}
	}
	if pois == nil {
		pois = []POI{}
	}
	c.search.Put(key, pois)
	return pois, nil
}

// query runs one /v2/search request. It returns the places (or the
// administrative area found), and for a statistics answer the code of the
// region with the most results.
func (c *Client) query(ctx context.Context, post map[string]any) ([]POI, string, error) {
	b, _ := json.Marshal(post)
	q := url.Values{}
	q.Set("postStr", string(b))
	q.Set("type", "query")
	data, err := c.get(ctx, "/v2/search", q)
	if err != nil {
		return nil, "", err
	}
	return parseSearch(data)
}

func parseSearch(data []byte) ([]POI, string, error) {
	var r searchResp
	if err := json.Unmarshal(data, &r); err != nil {
		return nil, "", fmt.Errorf("tianditu decode: %w", err)
	}
	if code := string(r.Status.Infocode); code != "" && code != "1000" {
		return nil, "", &Error{Code: code, Msg: string(r.Status.Cndesc)}
	}
	var out []POI
	for _, p := range r.Pois {
		if poi, ok := p.toPOI(); ok {
			out = append(out, poi)
		}
	}
	for _, a := range r.Area {
		if lng, lat, ok := parseLonlat(string(a.Lonlat)); ok && a.Name != "" {
			out = append(out, POI{Name: string(a.Name), City: string(a.Name), Category: "other", Lng: lng, Lat: lat})
		}
	}
	region := ""
	for _, s := range r.Statistics {
		for _, l := range []list[areaJSON]{s.PriorityCitys, s.AllAdmins} {
			if len(l) > 0 && region == "" {
				region = specifyOf(string(l[0].AdminCode))
			}
		}
	}
	return out, region, nil
}

// Regeo is a reverse-geocoding result.
type Regeo struct {
	Province     string
	City         string
	District     string // county
	Town         string // 乡镇 / 街道
	Road         string
	Address      string  // formatted address
	Nearby       string  // nearest address text (addressComponent.address)
	POI          string  // nearest POI
	POIDistanceM float64 // its distance in metres (-1 if unknown)
	POIDirection string  // where the point is relative to it, e.g. "东北"
}

// Regeo reverse-geocodes a GCJ-02 point (cached for a day).
func (c *Client) Regeo(ctx context.Context, lng, lat float64) (*Regeo, error) {
	key := fmt.Sprintf("%.5f,%.5f", lng, lat)
	if r, ok := c.regeo.Get(key); ok {
		return r, nil
	}
	wl, wt := geo.GCJ02ToWGS84(lng, lat)
	b, _ := json.Marshal(map[string]any{"lon": geo.Round(wl, 6), "lat": geo.Round(wt, 6), "ver": 1})
	q := url.Values{}
	q.Set("postStr", string(b))
	q.Set("type", "geocode")
	data, err := c.get(ctx, "/geocoder", q)
	if err != nil {
		return nil, err
	}
	r, err := parseRegeo(data)
	if err != nil {
		return nil, err
	}
	c.regeo.Put(key, r)
	return r, nil
}

func parseRegeo(data []byte) (*Regeo, error) {
	var resp struct {
		Status flex `json:"status"`
		Msg    flex `json:"msg"`
		Result struct {
			FormattedAddress flex `json:"formatted_address"`
			AddressComponent struct {
				Address     flex `json:"address"`
				Province    flex `json:"province"`
				City        flex `json:"city"`
				County      flex `json:"county"`
				Town        flex `json:"town"`
				Road        flex `json:"road"`
				POI         flex `json:"poi"`
				POIDistance flex `json:"poi_distance"`
				POIPosition flex `json:"poi_position"`
			} `json:"addressComponent"`
		} `json:"result"`
	}
	if err := json.Unmarshal(data, &resp); err != nil {
		return nil, fmt.Errorf("tianditu decode: %w", err)
	}
	if s := string(resp.Status); s != "" && s != "0" {
		return nil, &Error{Code: s, Msg: string(resp.Msg)}
	}
	ac := resp.Result.AddressComponent
	r := &Regeo{Province: string(ac.Province), City: string(ac.City), District: string(ac.County), Town: string(ac.Town),
		Road: string(ac.Road), Address: string(resp.Result.FormattedAddress), Nearby: string(ac.Address),
		POI: strings.TrimSpace(string(ac.POI)), POIDistanceM: -1, POIDirection: string(ac.POIPosition)}
	if d, ok := ac.POIDistance.float(); ok && d >= 0 {
		r.POIDistanceM = d
	}
	if r.City == "" {
		r.City = r.Province // municipalities
	}
	return r, nil
}

// Check sends a live search (天安门 in 北京), bypassing the cache and the
// breaker, for the admin diagnostics. A success lifts a pause.
func (c *Client) Check(ctx context.Context) error {
	if !c.Enabled() {
		return ErrUnavailable
	}
	b, _ := json.Marshal(map[string]any{"keyWord": "天安门", "queryType": 12, "specify": "156110000", "start": 0, "count": 1})
	q := url.Values{}
	q.Set("postStr", string(b))
	q.Set("type", "query")
	data, err := c.fetch(ctx, "/v2/search", q)
	if err != nil {
		return err
	}
	if _, _, err := parseSearch(data); err != nil {
		return err
	}
	c.failUntil.Store(0)
	return nil
}

// Category maps a Tianditu typeName ("中餐馆", "宾馆", "风景名胜"…) to a
// TripHub category (best effort).
func Category(t string) string {
	has := func(words ...string) bool {
		for _, w := range words {
			if strings.Contains(t, w) {
				return true
			}
		}
		return false
	}
	switch {
	case t == "":
		return "other"
	case has("宾馆", "酒店", "旅馆", "旅店", "民宿", "客栈", "住宿", "招待所", "青年旅舍"):
		return "hotel"
	case has("餐", "饭", "小吃", "快餐", "咖啡", "茶馆", "茶楼", "面包", "甜品", "美食"):
		return "food"
	case has("景", "名胜", "公园", "博物", "纪念", "寺", "庙", "宫", "古迹", "动物园", "植物园", "游乐"):
		return "scenic"
	case has("商场", "超市", "购物", "商店", "市场", "商城", "专卖"):
		return "shopping"
	case has("车站", "机场", "码头", "港口", "地铁", "火车", "客运", "停车", "加油", "公交"):
		return "transport"
	case has("娱乐", "影院", "电影", "KTV", "酒吧", "体育", "健身", "网吧", "剧"):
		return "entertainment"
	}
	return "other"
}
