package geo

import "math"

// EarthRadius is the mean earth radius in metres.
const EarthRadius = 6371008.8

// Point is a lng/lat pair.
type Point struct {
	Lng, Lat float64
}

// Haversine returns the great-circle distance in metres between two points.
func Haversine(lng1, lat1, lng2, lat2 float64) float64 {
	rad := math.Pi / 180
	dLat := (lat2 - lat1) * rad
	dLng := (lng2 - lng1) * rad
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*rad)*math.Cos(lat2*rad)*math.Sin(dLng/2)*math.Sin(dLng/2)
	return 2 * EarthRadius * math.Asin(math.Min(1, math.Sqrt(a)))
}

// PathLength returns the length of a polyline in metres.
func PathLength(pts []Point) float64 {
	total := 0.0
	for i := 1; i < len(pts); i++ {
		total += Haversine(pts[i-1].Lng, pts[i-1].Lat, pts[i].Lng, pts[i].Lat)
	}
	return total
}

// BBoxAround returns an approximate lng/lat bounding box of radius metres
// around a point, suitable for SQL pre-filtering.
func BBoxAround(lng, lat, radius float64) (minLng, minLat, maxLng, maxLat float64) {
	dLat := radius / 111320.0
	cos := math.Cos(lat * math.Pi / 180)
	if cos < 0.01 {
		cos = 0.01
	}
	dLng := radius / (111320.0 * cos)
	return lng - dLng, lat - dLat, lng + dLng, lat + dLat
}

// Round rounds v to n decimal places.
func Round(v float64, n int) float64 {
	p := math.Pow(10, float64(n))
	return math.Round(v*p) / p
}
