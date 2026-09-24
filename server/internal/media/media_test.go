package media

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func encode(t *testing.T, format string, w, h int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.NRGBA{uint8(x), uint8(y), 200, uint8(x % 256)})
		}
	}
	var buf bytes.Buffer
	var err error
	switch format {
	case "png":
		err = png.Encode(&buf, img)
	case "gif":
		err = gif.Encode(&buf, img, nil)
	default:
		err = jpeg.Encode(&buf, img, nil)
	}
	if err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestSaveImage(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir, 1)
	for _, tc := range []struct {
		format       string
		w, h         int
		wantW, wantH int
		ext          string
	}{
		{"jpeg", 3000, 1500, 2560, 1280, ".jpg"},
		{"png", 300, 200, 300, 200, ".jpg"},
		{"gif", 600, 400, 600, 400, ".gif"},
	} {
		saved, err := s.SaveImage(encode(t, tc.format, tc.w, tc.h))
		if err != nil {
			t.Fatalf("%s: %v", tc.format, err)
		}
		if saved.Width != tc.wantW || saved.Height != tc.wantH || filepath.Ext(saved.Path) != tc.ext {
			t.Fatalf("%s: %+v", tc.format, saved)
		}
		if got := ThumbURL(URL(saved.Path)); got != URL(saved.ThumbPath) {
			t.Fatalf("%s: ThumbURL(%s) = %s, want %s", tc.format, URL(saved.Path), got, URL(saved.ThumbPath))
		}
		st1, err1 := os.Stat(filepath.Join(dir, saved.Path))
		st2, err2 := os.Stat(filepath.Join(dir, saved.ThumbPath))
		if err1 != nil || err2 != nil || st1.Size()+st2.Size() != saved.Size {
			t.Fatalf("%s: files %v %v", tc.format, err1, err2)
		}
		f, _ := os.Open(filepath.Join(dir, saved.ThumbPath))
		cfg, _, err := image.DecodeConfig(f)
		f.Close()
		if err != nil || (cfg.Width != ThumbDimension && cfg.Height != ThumbDimension && cfg.Width > ThumbDimension) {
			t.Fatalf("%s thumb: %+v %v", tc.format, cfg, err)
		}
		s.Remove(saved.Path, saved.ThumbPath)
		if _, err := os.Stat(filepath.Join(dir, saved.Path)); !os.IsNotExist(err) {
			t.Fatal("file should be removed")
		}
	}
	if _, err := s.SaveImage([]byte("hello")); err != ErrUnsupported {
		t.Fatalf("expected ErrUnsupported, got %v", err)
	}
	rel, err := s.SaveAvatar(encode(t, "png", 500, 300), 7)
	if err != nil || filepath.Dir(rel) != "avatars" {
		t.Fatalf("avatar: %s %v", rel, err)
	}
}

func TestURLHelpers(t *testing.T) {
	if URL("2026/09/a.jpg") != "/uploads/2026/09/a.jpg" || URL("") != "" {
		t.Fatal("URL")
	}
	if rel, ok := RelFromURL("/uploads/2026/09/a.jpg"); !ok || rel != "2026/09/a.jpg" {
		t.Fatal("RelFromURL")
	}
	if _, ok := RelFromURL("/uploads/../etc/passwd"); ok {
		t.Fatal("path traversal accepted")
	}
	// Anything but an image stored by SaveImage has no separate thumbnail.
	for _, u := range []string{"", "/uploads/avatars/7_0123456789ab.jpg", "/uploads/2026/09/0123456789abcdef01234567_t.jpg",
		"/uploads/2026/09/0123456789abcdef01234567.png", "https://example.com/2026/09/0123456789abcdef01234567.jpg"} {
		if got := ThumbURL(u); got != u {
			t.Fatalf("ThumbURL(%q) = %q", u, got)
		}
	}
	loc, _ := time.LoadLocation("Asia/Shanghai")
	if ex := ReadExif(encode(t, "jpeg", 10, 10), loc); ex.Lng != nil || ex.TakenAt != nil {
		t.Fatal("no EXIF expected")
	}
}

// pngChunk appends a PNG chunk (length, type, data, CRC).
func pngChunk(buf *bytes.Buffer, typ string, data []byte) {
	_ = binary.Write(buf, binary.BigEndian, uint32(len(data)))
	crc := crc32.NewIEEE()
	crc.Write([]byte(typ))
	crc.Write(data)
	buf.WriteString(typ)
	buf.Write(data)
	_ = binary.Write(buf, binary.BigEndian, crc.Sum32())
}

// zeroPNG builds an all-zero RGBA PNG (colour type 6) of the given bit depth.
// With rows=false only the header is written, which is all probe reads.
func zeroPNG(w, h int, depth byte, interlace byte, rows bool) []byte {
	var buf bytes.Buffer
	buf.WriteString("\x89PNG\r\n\x1a\n")
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:], uint32(w))
	binary.BigEndian.PutUint32(ihdr[4:], uint32(h))
	ihdr[8], ihdr[9], ihdr[12] = depth, 6, interlace
	pngChunk(&buf, "IHDR", ihdr)
	if rows {
		// Stream the filtered scanlines through zlib; the bitmap is never built.
		var z bytes.Buffer
		zw, _ := zlib.NewWriterLevel(&z, zlib.BestSpeed)
		row := make([]byte, 1+w*4*int(depth/8))
		for y := 0; y < h; y++ {
			_, _ = zw.Write(row)
		}
		_ = zw.Close()
		pngChunk(&buf, "IDAT", z.Bytes())
	}
	pngChunk(&buf, "IEND", nil)
	return buf.Bytes()
}

func TestDecompressionBomb(t *testing.T) {
	s := NewStore(t.TempDir(), 1)
	// ~1 MB on disk, 800 MB as a decoded 16-bit bitmap.
	bomb := zeroPNG(10000, 10000, 16, 0, true)
	if len(bomb) > 2<<20 {
		t.Fatalf("bomb is %d bytes", len(bomb))
	}
	if _, err := s.SaveImage(bomb); err != ErrTooLarge {
		t.Fatalf("SaveImage(bomb) = %v, want ErrTooLarge", err)
	}
	if _, err := s.SaveAvatar(bomb, 1); err != ErrTooLarge {
		t.Fatalf("SaveAvatar(bomb) = %v, want ErrTooLarge", err)
	}
	for _, tc := range []struct {
		name  string
		data  []byte
		large bool
	}{
		{"49 MP 16-bit", zeroPNG(7000, 7000, 16, 0, false), true}, // under the pixel limit, 392 MB decoded
		{"21 MP 8-bit", zeroPNG(4600, 4600, 8, 0, false), false},
		{"21 MP 8-bit interlaced", zeroPNG(4600, 4600, 8, 1, false), true}, // Adam7 decodes per pass
		{"8 MP 16-bit", zeroPNG(2000, 2000, 16, 0, false), false},
	} {
		_, _, err := probe(tc.data)
		if (err == ErrTooLarge) != tc.large {
			t.Errorf("%s: probe = %v, want too large = %v", tc.name, err, tc.large)
		}
	}
	// A normal 16-bit PNG is still accepted.
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewNRGBA64(image.Rect(0, 0, 1000, 1000))); err != nil {
		t.Fatal(err)
	}
	if saved, err := s.SaveImage(buf.Bytes()); err != nil || saved.Width != 1000 || saved.Height != 1000 {
		t.Fatalf("16-bit PNG: %+v %v", saved, err)
	}
}

// withOrientation inserts an EXIF APP1 segment with the given orientation
// right after the JPEG SOI marker.
func withOrientation(jpg []byte, o uint16) []byte {
	tiff := []byte{'M', 'M', 0, 42, 0, 0, 0, 8, // big-endian header, IFD0 at offset 8
		0, 1, // one entry
		0x01, 0x12, 0, 3, 0, 0, 0, 1, byte(o >> 8), byte(o), 0, 0, // Orientation, SHORT, count 1
		0, 0, 0, 0} // no next IFD
	payload := append([]byte("Exif\x00\x00"), tiff...)
	seg := []byte{0xFF, 0xE1, byte((len(payload) + 2) >> 8), byte(len(payload) + 2)}
	out := append([]byte{}, jpg[:2]...)
	out = append(out, seg...)
	out = append(out, payload...)
	return append(out, jpg[2:]...)
}

func TestSaveImageOrientation(t *testing.T) {
	s := NewStore(t.TempDir(), 1)
	img := withOrientation(encode(t, "jpeg", 300, 200), 6) // stored landscape, displayed portrait
	if o := jpegOrientation(img); o != 6 {
		t.Fatalf("orientation %d", o)
	}
	saved, err := s.SaveImage(img)
	if err != nil || saved.Width != 200 || saved.Height != 300 {
		t.Fatalf("oriented image: %+v %v", saved, err)
	}
	big, err := s.SaveImage(withOrientation(encode(t, "jpeg", 4000, 3000), 6))
	if err != nil || big.Width != 1920 || big.Height != 2560 {
		t.Fatalf("downscaled oriented image: %+v %v", big, err)
	}
	if _, err := s.SaveAvatar(img, 1); err != nil {
		t.Fatalf("avatar: %v", err)
	}
	if o := jpegOrientation(encode(t, "png", 10, 10)); o != 1 {
		t.Fatalf("png orientation %d", o)
	}
}
