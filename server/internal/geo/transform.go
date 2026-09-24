// Package geo implements coordinate conversion (WGS-84 ⇄ GCJ-02), distances,
// polyline simplification and an offline province/prefecture lookup based on
// an embedded TopoJSON atlas of China.
package geo

import "math"

// Krasovsky 1940 ellipsoid parameters used by the GCJ-02 obfuscation.
const (
	gcjA  = 6378245.0
	gcjEE = 0.00669342162296594323
)

// OutOfChina reports whether a coordinate lies outside the rough bounding box
// in which GCJ-02 obfuscation is applied.
func OutOfChina(lng, lat float64) bool {
	return !(lng > 72.004 && lng < 137.8347 && lat > 0.8293 && lat < 55.8271)
}

func transformLat(x, y float64) float64 {
	ret := -100.0 + 2.0*x + 3.0*y + 0.2*y*y + 0.1*x*y + 0.2*math.Sqrt(math.Abs(x))
	ret += (20.0*math.Sin(6.0*x*math.Pi) + 20.0*math.Sin(2.0*x*math.Pi)) * 2.0 / 3.0
	ret += (20.0*math.Sin(y*math.Pi) + 40.0*math.Sin(y/3.0*math.Pi)) * 2.0 / 3.0
	ret += (160.0*math.Sin(y/12.0*math.Pi) + 320*math.Sin(y*math.Pi/30.0)) * 2.0 / 3.0
	return ret
}

func transformLng(x, y float64) float64 {
	ret := 300.0 + x + 2.0*y + 0.1*x*x + 0.1*x*y + 0.1*math.Sqrt(math.Abs(x))
	ret += (20.0*math.Sin(6.0*x*math.Pi) + 20.0*math.Sin(2.0*x*math.Pi)) * 2.0 / 3.0
	ret += (20.0*math.Sin(x*math.Pi) + 40.0*math.Sin(x/3.0*math.Pi)) * 2.0 / 3.0
	ret += (150.0*math.Sin(x/12.0*math.Pi) + 300.0*math.Sin(x/30.0*math.Pi)) * 2.0 / 3.0
	return ret
}

func gcjDelta(lng, lat float64) (dLng, dLat float64) {
	dLat = transformLat(lng-105.0, lat-35.0)
	dLng = transformLng(lng-105.0, lat-35.0)
	radLat := lat / 180.0 * math.Pi
	magic := math.Sin(radLat)
	magic = 1 - gcjEE*magic*magic
	sqrtMagic := math.Sqrt(magic)
	dLat = (dLat * 180.0) / ((gcjA * (1 - gcjEE)) / (magic * sqrtMagic) * math.Pi)
	dLng = (dLng * 180.0) / (gcjA / sqrtMagic * math.Cos(radLat) * math.Pi)
	return dLng, dLat
}

// WGS84ToGCJ02 converts a GPS (WGS-84) coordinate to GCJ-02. Coordinates
// outside China are returned unchanged.
func WGS84ToGCJ02(lng, lat float64) (float64, float64) {
	if OutOfChina(lng, lat) {
		return lng, lat
	}
	dLng, dLat := gcjDelta(lng, lat)
	return lng + dLng, lat + dLat
}

// GCJ02ToWGS84 converts a GCJ-02 coordinate back to WGS-84 using fixed-point
// iteration (sub-centimetre accuracy). Coordinates outside China are returned
// unchanged.
func GCJ02ToWGS84(lng, lat float64) (float64, float64) {
	if OutOfChina(lng, lat) {
		return lng, lat
	}
	wLng, wLat := lng, lat
	for i := 0; i < 30; i++ {
		gLng, gLat := WGS84ToGCJ02(wLng, wLat)
		dLng, dLat := gLng-lng, gLat-lat
		wLng -= dLng
		wLat -= dLat
		if math.Abs(dLng) < 1e-10 && math.Abs(dLat) < 1e-10 {
			break
		}
	}
	return wLng, wLat
}

// ToGCJ02 converts a coordinate given in coordType ("wgs84" or "gcj02") to GCJ-02.
func ToGCJ02(lng, lat float64, coordType string) (float64, float64) {
	if coordType == "wgs84" {
		return WGS84ToGCJ02(lng, lat)
	}
	return lng, lat
}

// ValidCoord reports whether lng/lat are finite, in range and not the (0,0) placeholder.
func ValidCoord(lng, lat float64) bool {
	if math.IsNaN(lng) || math.IsNaN(lat) || math.IsInf(lng, 0) || math.IsInf(lat, 0) {
		return false
	}
	if lng < -180 || lng > 180 || lat < -90 || lat > 90 {
		return false
	}
	return !(lng == 0 && lat == 0)
}
