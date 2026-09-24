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
// around China. It is only the coarse pre-check: the box also covers
// neighbouring countries, which InGCJArea excludes before any offset is applied.
func OutOfChina(lng, lat float64) bool {
	return !(lng > 72.004 && lng < 137.8347 && lat > 0.8293 && lat < 55.8271)
}

// gcjExclude lists areas inside the OutOfChina box where no GCJ-02 offset is
// applied, as {minLng, minLat, maxLng, maxLat}: 高德 / 腾讯 / Apple use WGS-84
// abroad. They cover Korea and western Japan, the Ryukyu Islands, the
// Philippines and Palau, southern North Korea, Primorye and Khabarovsk,
// Siberia and Mongolia, Kazakhstan and Kyrgyzstan, India, Pakistan, Nepal,
// Bhutan and Bangladesh, Myanmar and mainland Southeast Asia, Vietnam, Borneo
// and Palawan. Every box is at least 15 km from Chinese territory in the
// embedded atlas (see TestGCJExcludeAvoidsChina); places closer to the border
// keep the offset. Keep in sync with web/src/lib/geo.ts (GCJ_EXCLUDE).
var gcjExclude = [...][4]float64{
	{124.0, 30.0, 137.8347, 38.3}, {124.0, 24.0, 137.8347, 25.4}, {125.0, 25.4, 137.8347, 30.0},
	{119.3, 0.8293, 137.8347, 20.8}, {123.0, 20.8, 137.8347, 24.0}, {124.8, 38.3, 130.0, 40.0},
	{131.6, 42.3, 137.8347, 44.3}, {135.5, 44.3, 137.8347, 55.8271}, {88.0, 49.5, 115.0, 55.8271},
	{92.0, 46.0, 115.0, 49.5}, {91.0, 47.5, 92.0, 49.5}, {97.0, 43.5, 110.5, 46.0},
	{72.004, 42.0, 79.0, 55.8271}, {79.0, 49.8, 86.5, 55.8271}, {72.004, 40.2, 73.6, 42.0},
	{72.004, 0.8293, 88.0, 26.0}, {72.004, 26.0, 78.0, 31.3}, {72.004, 31.3, 75.8, 34.5},
	{78.0, 26.0, 80.0, 29.5}, {80.0, 26.0, 86.5, 27.75}, {82.0, 27.75, 84.3, 28.5},
	{86.5, 26.0, 88.0, 27.3}, {89.45, 26.3, 91.3, 27.6}, {88.0, 20.5, 92.3, 26.3},
	{92.3, 10.0, 97.0, 26.0}, {92.3, 0.8293, 105.5, 20.0}, {105.5, 0.8293, 109.0, 12.0},
	{105.5, 12.0, 109.6, 16.3}, {102.2, 16.0, 107.8, 21.2}, {109.5, 0.8293, 119.3, 3.3},
	{113.6, 3.3, 119.3, 6.5}, {115.5, 6.5, 119.3, 7.5}, {118.2, 7.5, 119.3, 12.5},
}

// InGCJArea reports whether GCJ-02 obfuscation applies at a coordinate: inside
// the OutOfChina box and outside the neighbouring countries of gcjExclude.
func InGCJArea(lng, lat float64) bool {
	if OutOfChina(lng, lat) {
		return false
	}
	for _, b := range gcjExclude {
		if lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3] {
			return false
		}
	}
	return true
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
// outside China (see InGCJArea) are returned unchanged.
func WGS84ToGCJ02(lng, lat float64) (float64, float64) {
	if !InGCJArea(lng, lat) {
		return lng, lat
	}
	dLng, dLat := gcjDelta(lng, lat)
	return lng + dLng, lat + dLat
}

// GCJ02ToWGS84 converts a GCJ-02 coordinate back to WGS-84 using fixed-point
// iteration (sub-centimetre accuracy). Coordinates outside China (see
// InGCJArea) are returned unchanged.
func GCJ02ToWGS84(lng, lat float64) (float64, float64) {
	if !InGCJArea(lng, lat) {
		return lng, lat
	}
	wLng, wLat := lng, lat
	for i := 0; i < 30; i++ {
		// The area is tested once, on the input, so the iteration cannot
		// flip between offset and no offset at the edge of an area.
		dl, dt := gcjDelta(wLng, wLat)
		gLng, gLat := wLng+dl, wLat+dt
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
