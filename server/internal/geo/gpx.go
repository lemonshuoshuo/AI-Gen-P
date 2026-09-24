package geo

import (
	"encoding/xml"
	"errors"
	"io"
	"strconv"
	"strings"
	"time"
)

// GPXPoint is a timed track point read from a GPX file (WGS-84 as stored).
type GPXPoint struct {
	Lng, Lat, Ele float64
	Time          time.Time
}

// ErrTooManyPoints is returned by ParseGPX when a file exceeds maxPoints.
var ErrTooManyPoints = errors.New("gpx: too many points")

// ParseGPX reads the track segments (gpx > trk > trkseg > trkpt) of a GPX
// 1.0 / 1.1 document; routes and waypoints are ignored. Points without a
// valid position or time are skipped and empty segments dropped. With
// maxPoints > 0 it stops with ErrTooManyPoints once more points were read.
func ParseGPX(r io.Reader, maxPoints int) ([][]GPXPoint, error) {
	dec := xml.NewDecoder(r)
	var segs [][]GPXPoint
	var cur []GPXPoint
	inSeg, total := false, 0
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		switch el := tok.(type) {
		case xml.StartElement:
			switch el.Name.Local {
			case "trkseg":
				inSeg, cur = true, nil
			case "trkpt":
				if !inSeg {
					if err := dec.Skip(); err != nil {
						return nil, err
					}
					continue
				}
				var raw struct {
					Lat  string `xml:"lat,attr"`
					Lon  string `xml:"lon,attr"`
					Ele  string `xml:"ele"`
					Time string `xml:"time"`
				}
				if err := dec.DecodeElement(&raw, &el); err != nil {
					return nil, err
				}
				p, ok := gpxPoint(raw.Lon, raw.Lat, raw.Ele, raw.Time)
				if !ok {
					continue
				}
				if total++; maxPoints > 0 && total > maxPoints {
					return nil, ErrTooManyPoints
				}
				cur = append(cur, p)
			}
		case xml.EndElement:
			if el.Name.Local == "trkseg" {
				if len(cur) > 0 {
					segs = append(segs, cur)
				}
				inSeg, cur = false, nil
			}
		}
	}
	return segs, nil
}

func gpxPoint(lon, lat, ele, ts string) (GPXPoint, bool) {
	x, err1 := strconv.ParseFloat(strings.TrimSpace(lon), 64)
	y, err2 := strconv.ParseFloat(strings.TrimSpace(lat), 64)
	if err1 != nil || err2 != nil || !ValidCoord(x, y) {
		return GPXPoint{}, false
	}
	ts = strings.TrimSpace(ts)
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		// Times without a zone are UTC in GPX.
		if t, err = time.ParseInLocation("2006-01-02T15:04:05.999999999", ts, time.UTC); err != nil {
			return GPXPoint{}, false
		}
	}
	p := GPXPoint{Lng: x, Lat: y, Time: t}
	if v, err := strconv.ParseFloat(strings.TrimSpace(ele), 64); err == nil {
		p.Ele = v
	}
	return p, true
}
