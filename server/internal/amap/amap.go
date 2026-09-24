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
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// ErrUnavailable means the API is not configured or temporarily disabled.
var ErrUnavailable = errors.New("amap unavailable")

// DefaultBaseURL is the AMap REST endpoint.
const DefaultBaseURL = "https://restapi.amap.com"

// Client talks to the AMap web service API.
type Client struct {
	key       string
	baseURL   string
	http      *http.Client
	regeo     *lru[*Regeo]
	failUntil atomic.Int64 // unix nanos; circuit breaker after network errors
}

// New creates a client. An empty key yields a disabled client.
func New(key string) *Client {
	return &Client{
		key:     key,
		baseURL: DefaultBaseURL,
		http:    &http.Client{Timeout: 3 * time.Second},
		regeo:   newLRU[*Regeo](20000, 24*time.Hour),
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

func (c *Client) get(ctx context.Context, path string, q url.Values, out any) error {
	if !c.available() {
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
		// Network failure: back off for a while so requests fail fast.
		c.failUntil.Store(time.Now().Add(60 * time.Second).UnixNano())
		slog.Warn("amap request failed, disabling for 60s", "path", path, "err", err)
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		c.failUntil.Store(time.Now().Add(30 * time.Second).UnixNano())
		return fmt.Errorf("%w: http %d", ErrUnavailable, resp.StatusCode)
	}
	raw := json.RawMessage{}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return fmt.Errorf("amap decode: %w", err)
	}
	var br baseResp
	_ = json.Unmarshal(raw, &br)
	if br.Status != "1" {
		return fmt.Errorf("amap error %s: %s", br.Infocode, br.Info)
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
// cityLimit restricts results to that city.
func (c *Client) Search(ctx context.Context, keyword, city string, cityLimit bool, limit int) ([]POI, error) {
	if limit <= 0 || limit > 25 {
		limit = 20
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
	return convertPOIs(resp.Pois), nil
}

// Around searches near a GCJ-02 point (/v3/place/around), sorted by distance.
// types is an AMap type code list such as "050000|110000".
func (c *Client) Around(ctx context.Context, lng, lat float64, radius int, types, keyword string, limit int) ([]POI, error) {
	if limit <= 0 || limit > 25 {
		limit = 20
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
	return convertPOIs(resp.Pois), nil
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
