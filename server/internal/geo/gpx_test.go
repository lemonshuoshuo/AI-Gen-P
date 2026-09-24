package geo

import (
	"strings"
	"testing"
	"time"
)

const sampleGPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="30.1" lon="120.1"><time>2026-05-01T00:00:00Z</time></wpt>
  <rte><rtept lat="30.2" lon="120.2"><time>2026-05-01T00:00:00Z</time></rtept></rte>
  <trk><name>西湖</name>
    <trkseg>
      <trkpt lat="30.2610" lon="120.1513"><ele>12.5</ele><time>2026-05-01T01:00:00Z</time></trkpt>
      <trkpt lat="30.2620" lon="120.1523"><time>2026-05-01T09:00:10.500+08:00</time><extensions><hr>90</hr></extensions></trkpt>
      <trkpt lat="30.2630" lon="120.1533"></trkpt>
      <trkpt lat="bad" lon="120.1533"><time>2026-05-01T01:00:20Z</time></trkpt>
    </trkseg>
    <trkseg></trkseg>
    <trkseg>
      <trkpt lat="30.3" lon="120.3"><time>2026-05-01T02:00:00</time></trkpt>
    </trkseg>
  </trk>
</gpx>`

func TestParseGPX(t *testing.T) {
	segs, err := ParseGPX(strings.NewReader(sampleGPX), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(segs) != 2 || len(segs[0]) != 2 || len(segs[1]) != 1 {
		t.Fatalf("segments: %+v", segs)
	}
	p := segs[0][0]
	if p.Lng != 120.1513 || p.Lat != 30.2610 || p.Ele != 12.5 || !p.Time.Equal(time.Date(2026, 5, 1, 1, 0, 0, 0, time.UTC)) {
		t.Fatalf("first point: %+v", p)
	}
	if want := time.Date(2026, 5, 1, 1, 0, 10, 500e6, time.UTC); !segs[0][1].Time.Equal(want) {
		t.Fatalf("offset time: %v", segs[0][1].Time)
	}
	if want := time.Date(2026, 5, 1, 2, 0, 0, 0, time.UTC); !segs[1][0].Time.Equal(want) {
		t.Fatalf("zone-less time should be UTC: %v", segs[1][0].Time)
	}
	if _, err := ParseGPX(strings.NewReader(sampleGPX), 2); err != ErrTooManyPoints {
		t.Fatalf("limit: %v", err)
	}
	if _, err := ParseGPX(strings.NewReader("<gpx><trk><trkseg><trkpt"), 0); err == nil {
		t.Fatal("truncated file accepted")
	}
	if segs, err := ParseGPX(strings.NewReader("<gpx></gpx>"), 0); err != nil || len(segs) != 0 {
		t.Fatalf("empty: %v %v", segs, err)
	}
}
