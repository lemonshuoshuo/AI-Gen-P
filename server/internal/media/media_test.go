package media

import (
	"bytes"
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
	loc, _ := time.LoadLocation("Asia/Shanghai")
	if ex := ReadExif(encode(t, "jpeg", 10, 10), loc); ex.Lng != nil || ex.TakenAt != nil {
		t.Fatal("no EXIF expected")
	}
}
