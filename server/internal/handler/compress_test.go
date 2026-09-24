package handler

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"

	"triphub/internal/config"
)

func gunzip(t *testing.T, b []byte) []byte {
	t.Helper()
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		t.Fatalf("not gzip: %v", err)
	}
	out, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("gunzip: %v", err)
	}
	return out
}

func TestCompression(t *testing.T) {
	js := bytes.Repeat([]byte("console.log('triphub');\n"), 2000)
	// fstest.MapFS rather than webui.FS(): in CI the embedded dist may be empty.
	h := &Handler{cfg: &config.Config{CORSOrigins: []string{"*"}}, webui: fstest.MapFS{
		"assets/app-x.js": {Data: js},
		"index.html":      {Data: []byte("<!doctype html><div id=root></div>")},
	}}
	r := h.Router()
	do := func(method, path string, hdr ...string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, nil)
		for i := 0; i+1 < len(hdr); i += 2 {
			req.Header.Set(hdr[i], hdr[i+1])
		}
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w
	}

	// Static assets.
	w := do("GET", "/assets/app-x.js", "Accept-Encoding", "gzip, deflate, br, zstd")
	hd := w.Header()
	if w.Code != 200 || hd.Get("Content-Encoding") != "gzip" || !strings.Contains(hd.Get("Vary"), "Accept-Encoding") ||
		hd.Get("Content-Type") != "text/javascript; charset=utf-8" || hd.Get("Content-Length") != strconv.Itoa(w.Body.Len()) {
		t.Fatalf("gzip asset: %d %v", w.Code, hd)
	}
	if w.Body.Len() >= len(js)/4 || !bytes.Equal(gunzip(t, w.Body.Bytes()), js) {
		t.Fatalf("gzip asset body: %d bytes", w.Body.Len())
	}
	for _, ae := range []string{"", "gzip;q=0", "br"} {
		w := do("GET", "/assets/app-x.js", "Accept-Encoding", ae)
		if w.Code != 200 || w.Header().Get("Content-Encoding") != "" || !bytes.Equal(w.Body.Bytes(), js) {
			t.Fatalf("Accept-Encoding %q: %d %v", ae, w.Code, w.Header())
		}
	}
	w = do("GET", "/assets/app-x.js", "Accept-Encoding", "gzip", "Range", "bytes=0-99")
	if w.Code != http.StatusPartialContent || w.Header().Get("Content-Encoding") != "" || !bytes.Equal(w.Body.Bytes(), js[:100]) {
		t.Fatalf("range: %d %v", w.Code, w.Header())
	}
	w = do("HEAD", "/assets/app-x.js", "Accept-Encoding", "gzip")
	if w.Code != 200 || w.Header().Get("Content-Encoding") != "gzip" || w.Body.Len() != 0 {
		t.Fatalf("head: %d %v", w.Code, w.Header())
	}
	w = do("GET", "/index.html", "Accept-Encoding", "gzip") // too small to be worth it
	if w.Code != 200 || w.Header().Get("Content-Encoding") != "" || w.Header().Get("Content-Type") != "text/html; charset=utf-8" {
		t.Fatalf("small asset: %d %v", w.Code, w.Header())
	}

	// API JSON, including errors (a guest calling a login-only endpoint).
	w = do("GET", "/api/v1/geo/regeo", "Accept-Encoding", "gzip")
	if w.Code != 401 || w.Header().Get("Content-Encoding") != "gzip" || !strings.Contains(w.Header().Get("Vary"), "Accept-Encoding") {
		t.Fatalf("api gzip: %d %v", w.Code, w.Header())
	}
	var m map[string]any
	if err := json.Unmarshal(gunzip(t, w.Body.Bytes()), &m); err != nil || m["error"] == nil {
		t.Fatalf("api gzip body: %v %v", m, err)
	}
	w = do("GET", "/api/v1/geo/regeo")
	if w.Code != 401 || w.Header().Get("Content-Encoding") != "" || !json.Valid(w.Body.Bytes()) {
		t.Fatalf("api identity: %d %v", w.Code, w.Header())
	}

	// The atlas is gzipped by its handler: exactly one layer, and 304 has no body.
	w = do("GET", "/api/v1/geo/atlas", "Accept-Encoding", "gzip")
	if w.Code != 200 || w.Header().Get("Content-Encoding") != "gzip" || len(w.Header().Values("Vary")) != 1 ||
		!json.Valid(gunzip(t, w.Body.Bytes())) {
		t.Fatalf("atlas: %d %v", w.Code, w.Header())
	}
	w = do("GET", "/api/v1/geo/atlas", "Accept-Encoding", "gzip", "If-None-Match", w.Header().Get("ETag"))
	if w.Code != http.StatusNotModified || w.Body.Len() != 0 || w.Header().Get("Content-Encoding") != "" {
		t.Fatalf("atlas 304: %d %v", w.Code, w.Header())
	}

	// CORS preflight stays bodyless.
	w = do("OPTIONS", "/api/v1/trips", "Origin", "http://localhost:5173", "Accept-Encoding", "gzip")
	if w.Code != http.StatusNoContent || w.Body.Len() != 0 || w.Header().Get("Content-Encoding") != "" {
		t.Fatalf("preflight: %d %v", w.Code, w.Header())
	}

	for _, tc := range []struct {
		header string
		want   bool
	}{{"gzip", true}, {"GZIP", true}, {"deflate, gzip;q=0.5", true}, {"gzip;q=0", false}, {"gzip; q=0.0", false},
		{"br, zstd", false}, {"", false}, {"x-gzip", false}} {
		if got := acceptsGzip(tc.header); got != tc.want {
			t.Errorf("acceptsGzip(%q) = %v", tc.header, got)
		}
	}
}
