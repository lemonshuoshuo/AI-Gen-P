// Package media stores uploaded images: it normalises orientation, downsizes
// large images, re-encodes to JPEG (GIFs are kept as-is), writes 480px
// thumbnails and extracts EXIF GPS / capture time.
package media

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/color"
	_ "image/gif" // register decoder
	_ "image/png" // register decoder
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/disintegration/imaging"
	"github.com/rwcarlsen/goexif/exif"
	_ "golang.org/x/image/webp" // register decoder
)

// Limits for processed images.
const (
	MaxDimension   = 2560
	ThumbDimension = 480
	AvatarSize     = 256
	maxPixels      = 52_000_000 // 50 MP sensors produce 8192×6144 = 50.3 MP
	maxDecodeBytes = 160 << 20  // memory of the fully decoded image, see decodeCost
	jpegQuality    = 85
	thumbQuality   = 80
)

// Errors returned by SaveImage.
var (
	ErrUnsupported = errors.New("unsupported image format")
	ErrTooLarge    = errors.New("image dimensions too large")
)

// Store writes files under a root directory (DATA_DIR/uploads).
type Store struct {
	root string
	sem  chan struct{}
}

// NewStore creates a store; concurrency bounds simultaneous decodes to limit memory.
func NewStore(root string, concurrency int) *Store {
	if concurrency <= 0 {
		concurrency = 2
	}
	return &Store{root: root, sem: make(chan struct{}, concurrency)}
}

// Root returns the storage directory.
func (s *Store) Root() string { return s.root }

// Saved describes a stored image. Paths are relative to the root, using '/'.
type Saved struct {
	Path      string
	ThumbPath string
	Width     int
	Height    int
	Size      int64 // bytes on disk including the thumbnail
}

// URL returns the public URL for a relative path.
func URL(rel string) string {
	if rel == "" {
		return ""
	}
	return "/uploads/" + rel
}

// savedImageURL matches the URL of an image stored by SaveImage (see there
// for the naming), capturing the part its thumbnail shares.
var savedImageURL = regexp.MustCompile(`^(/uploads/\d{4}/\d{2}/[0-9a-f]{24})\.(?:jpg|gif)$`)

// ThumbURL returns the URL of the thumbnail stored with the image at URL u
// (for list cards), or u itself when u is not an image stored by SaveImage
// (an avatar, a thumbnail, an empty URL).
func ThumbURL(u string) string {
	if m := savedImageURL.FindStringSubmatch(u); m != nil {
		return m[1] + "_t.jpg"
	}
	return u
}

// RelFromURL returns the relative path of an /uploads/ URL.
func RelFromURL(u string) (string, bool) {
	if !strings.HasPrefix(u, "/uploads/") {
		return "", false
	}
	rel := path.Clean(strings.TrimPrefix(u, "/uploads/"))
	if rel == "." || strings.HasPrefix(rel, "..") || strings.HasPrefix(rel, "/") {
		return "", false
	}
	return rel, true
}

func randomName() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func (s *Store) acquire()              { s.sem <- struct{}{} }
func (s *Store) release()              { <-s.sem }
func (s *Store) abs(rel string) string { return filepath.Join(s.root, filepath.FromSlash(rel)) }

func (s *Store) write(rel string, data []byte) error {
	p := s.abs(rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func encodeJPEG(img image.Image, quality int) ([]byte, error) {
	var buf bytes.Buffer
	if err := imaging.Encode(&buf, img, imaging.JPEG, imaging.JPEGQuality(quality)); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// flatten draws an image with alpha onto a white background.
func flatten(img image.Image) image.Image {
	b := img.Bounds()
	bg := imaging.New(b.Dx(), b.Dy(), color.White)
	return imaging.Overlay(bg, img, image.Pt(0, 0), 1.0)
}

// decodeCost estimates the bytes the decoder allocates for the full image.
// A small compressed file (e.g. an all-zero 16-bit PNG) can decode to a huge
// bitmap, so this, not the file size, bounds memory.
func decodeCost(data []byte, cfg image.Config, format string) int64 {
	bpp := int64(4) // RGBA / NRGBA / CMYK / unknown
	switch cfg.ColorModel {
	case color.GrayModel:
		bpp = 1
	case color.Gray16Model:
		bpp = 2
	case color.YCbCrModel, color.NYCbCrAModel: // JPEG / lossy WebP, worst case 4:4:4
		bpp = 3
	case color.RGBA64Model, color.NRGBA64Model: // 16-bit PNG
		bpp = 8
	}
	if _, ok := cfg.ColorModel.(color.Palette); ok { // PNG-8 / GIF
		bpp = 1
	}
	if format == "webp" && cfg.ColorModel == color.NRGBAModel { // lossless VP8L: packed + unpacked buffers
		bpp = 6
	}
	if format == "png" && len(data) > 28 && data[28] == 1 { // Adam7 interlace flag in IHDR: per-pass images
		bpp *= 2
	}
	return int64(cfg.Width) * int64(cfg.Height) * bpp
}

// probe validates the format, pixel count and decoded size.
func probe(data []byte) (image.Config, string, error) {
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return cfg, "", ErrUnsupported
	}
	switch format {
	case "jpeg", "png", "gif", "webp":
	default:
		return cfg, "", ErrUnsupported
	}
	px := int64(cfg.Width) * int64(cfg.Height)
	if cfg.Width <= 0 || cfg.Height <= 0 || px > maxPixels || decodeCost(data, cfg, format) > maxDecodeBytes {
		return cfg, "", ErrTooLarge
	}
	return cfg, format, nil
}

// jpegOrientation returns the EXIF orientation (1–8) of JPEG data, 1 when absent.
func jpegOrientation(data []byte) int {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return 1
	}
	x, err := exif.Decode(bytes.NewReader(data))
	if err != nil || x == nil {
		return 1
	}
	tag, err := x.Get(exif.Orientation)
	if err != nil {
		return 1
	}
	o, err := tag.Int(0)
	if err != nil {
		return 1
	}
	return o
}

// orient applies an EXIF orientation (same mapping as imaging's
// AutoOrientation). Callers apply it after downscaling, so rotating never
// copies the full-size image.
func orient(img image.Image, o int) image.Image {
	switch o {
	case 2:
		return imaging.FlipH(img)
	case 3:
		return imaging.Rotate180(img)
	case 4:
		return imaging.FlipV(img)
	case 5:
		return imaging.Transpose(img)
	case 6:
		return imaging.Rotate270(img)
	case 7:
		return imaging.Transverse(img)
	case 8:
		return imaging.Rotate90(img)
	}
	return img
}

// SaveImage processes and stores an uploaded image plus its thumbnail.
func (s *Store) SaveImage(data []byte) (*Saved, error) {
	cfg, format, err := probe(data)
	if err != nil {
		return nil, err
	}
	s.acquire()
	defer s.release()

	dir := time.Now().Format("2006/01")
	name := randomName()
	out := &Saved{}
	var main []byte
	var img image.Image
	if format == "gif" {
		// Keep GIFs untouched so animations survive; thumbnail from the first frame.
		img, _, err = image.Decode(bytes.NewReader(data))
		if err != nil {
			return nil, ErrUnsupported
		}
		main = data
		out.Path = dir + "/" + name + ".gif"
		out.Width, out.Height = cfg.Width, cfg.Height
	} else {
		img, _, err = image.Decode(bytes.NewReader(data))
		if err != nil {
			return nil, ErrUnsupported
		}
		b := img.Bounds()
		if b.Dx() > MaxDimension || b.Dy() > MaxDimension {
			img = imaging.Fit(img, MaxDimension, MaxDimension, imaging.Lanczos)
		}
		img = orient(img, jpegOrientation(data)) // Width/Height below are in display orientation
		if format != "jpeg" {
			img = flatten(img)
		}
		if main, err = encodeJPEG(img, jpegQuality); err != nil {
			return nil, fmt.Errorf("encode jpeg: %w", err)
		}
		out.Path = dir + "/" + name + ".jpg"
		out.Width, out.Height = img.Bounds().Dx(), img.Bounds().Dy()
	}
	var thumbImg image.Image = imaging.Fit(img, ThumbDimension, ThumbDimension, imaging.Lanczos)
	if format == "gif" {
		thumbImg = flatten(thumbImg)
	}
	thumb, err := encodeJPEG(thumbImg, thumbQuality)
	if err != nil {
		return nil, fmt.Errorf("encode thumb: %w", err)
	}
	out.ThumbPath = dir + "/" + name + "_t.jpg"
	if err := s.write(out.Path, main); err != nil {
		return nil, err
	}
	if err := s.write(out.ThumbPath, thumb); err != nil {
		s.Remove(out.Path)
		return nil, err
	}
	out.Size = int64(len(main) + len(thumb))
	return out, nil
}

// SaveAvatar stores a square avatar and returns its relative path.
func (s *Store) SaveAvatar(data []byte, userID int64) (string, error) {
	if _, _, err := probe(data); err != nil {
		return "", err
	}
	s.acquire()
	defer s.release()
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return "", ErrUnsupported
	}
	// A centred square crop is the same whether it is oriented before or after.
	img = flatten(orient(imaging.Fill(img, AvatarSize, AvatarSize, imaging.Center, imaging.Lanczos), jpegOrientation(data)))
	b, err := encodeJPEG(img, jpegQuality)
	if err != nil {
		return "", err
	}
	rel := fmt.Sprintf("avatars/%d_%s.jpg", userID, randomName()[:12])
	return rel, s.write(rel, b)
}

// AvatarPrefix is the relative path prefix of a user's avatars.
func AvatarPrefix(userID int64) string { return fmt.Sprintf("avatars/%d_", userID) }

// Remove deletes stored files (missing files are ignored).
func (s *Store) Remove(rels ...string) {
	for _, rel := range rels {
		if rel == "" {
			continue
		}
		clean := path.Clean(rel)
		if strings.HasPrefix(clean, "..") || strings.HasPrefix(clean, "/") {
			continue
		}
		_ = os.Remove(s.abs(clean))
	}
}

// Exif holds metadata extracted from a JPEG.
type Exif struct {
	Lng, Lat *float64 // WGS-84
	TakenAt  *time.Time
}

// ReadExif extracts GPS position and capture time from JPEG data. Capture
// times without zone information are interpreted in loc.
func ReadExif(data []byte, loc *time.Location) Exif {
	var out Exif
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return out // not a JPEG
	}
	x, err := exif.Decode(bytes.NewReader(data))
	if err != nil || x == nil {
		return out
	}
	if lat, lng, err := x.LatLong(); err == nil && !(lat == 0 && lng == 0) &&
		lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 {
		out.Lng, out.Lat = &lng, &lat
	}
	for _, field := range []exif.FieldName{exif.DateTimeOriginal, exif.DateTimeDigitized, exif.DateTime} {
		tag, err := x.Get(field)
		if err != nil {
			continue
		}
		str, err := tag.StringVal()
		if err != nil {
			continue
		}
		str = strings.TrimRight(strings.TrimSpace(str), "\x00")
		if t, err := time.ParseInLocation("2006:01:02 15:04:05", str, loc); err == nil && t.Year() > 1990 {
			out.TakenAt = &t
			break
		}
	}
	return out
}
