package handler

import (
	"bytes"
	"compress/gzip"
	"io"
	"io/fs"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
)

// acceptsGzip reports whether an Accept-Encoding header allows gzip.
func acceptsGzip(header string) bool {
	for _, part := range strings.Split(header, ",") {
		coding, params, _ := strings.Cut(part, ";")
		if !strings.EqualFold(strings.TrimSpace(coding), "gzip") {
			continue
		}
		for _, p := range strings.Split(params, ";") {
			if k, v, ok := strings.Cut(strings.TrimSpace(p), "="); ok && strings.EqualFold(strings.TrimSpace(k), "q") {
				q, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
				return err == nil && q > 0
			}
		}
		return true
	}
	return false
}

// addVary adds token to the Vary header unless it is already listed.
func addVary(h http.Header, token string) {
	for _, v := range h.Values("Vary") {
		for _, t := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(t), token) {
				return
			}
		}
	}
	h.Add("Vary", token)
}

// compressibleAssets maps the extensions of embedded web assets served
// gzip-compressed to their Content-Type (set explicitly so compressed bytes
// are never sniffed).
var compressibleAssets = map[string]string{
	".js":          "text/javascript; charset=utf-8",
	".mjs":         "text/javascript; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".html":        "text/html; charset=utf-8",
	".json":        "application/json",
	".map":         "application/json",
	".svg":         "image/svg+xml",
	".txt":         "text/plain; charset=utf-8",
	".webmanifest": "application/manifest+json",
}

// gzAsset returns the gzip-compressed bytes of an embedded asset, compressing
// it once; nil means the asset is served as is (small or incompressible).
func (h *Handler) gzAsset(name string) []byte {
	if v, ok := h.gzAssets.Load(name); ok {
		return v.([]byte)
	}
	var out []byte
	if raw, err := fs.ReadFile(h.webui, name); err == nil && len(raw) >= 1024 {
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
		_, _ = zw.Write(raw)
		if zw.Close() == nil && buf.Len() < len(raw)*9/10 {
			out = buf.Bytes()
		}
	}
	v, _ := h.gzAssets.LoadOrStore(name, out)
	return v.([]byte)
}

var gzipWriters = sync.Pool{New: func() any {
	zw, _ := gzip.NewWriterLevel(io.Discard, gzip.DefaultCompression)
	return zw
}}

// gzipAPI compresses JSON / text responses for clients that accept gzip.
func gzipAPI() gin.HandlerFunc {
	return func(c *gin.Context) {
		addVary(c.Writer.Header(), "Accept-Encoding")
		if !acceptsGzip(c.GetHeader("Accept-Encoding")) {
			c.Next()
			return
		}
		gw := &gzipResponseWriter{ResponseWriter: c.Writer}
		c.Writer = gw
		defer func() {
			gw.close()
			c.Writer = gw.ResponseWriter
		}()
		c.Next()
	}
}

// gzipResponseWriter decides on the first body write whether to compress.
// WriteHeader is not intercepted: gin sends headers lazily on the first
// Write, so bodyless responses (204, 304, aborts) are never marked gzip.
type gzipResponseWriter struct {
	gin.ResponseWriter
	zw      *gzip.Writer
	decided bool
}

func (w *gzipResponseWriter) start() {
	if w.decided {
		return
	}
	w.decided = true
	h := w.Header()
	status := w.Status()
	ct := h.Get("Content-Type")
	if h.Get("Content-Encoding") != "" || status < 200 || status == http.StatusNoContent || status == http.StatusNotModified ||
		!(strings.HasPrefix(ct, "application/json") || strings.HasPrefix(ct, "text/")) {
		return
	}
	h.Set("Content-Encoding", "gzip")
	h.Del("Content-Length")
	w.zw = gzipWriters.Get().(*gzip.Writer)
	w.zw.Reset(w.ResponseWriter)
}

func (w *gzipResponseWriter) Write(b []byte) (int, error) {
	w.start()
	if w.zw == nil {
		return w.ResponseWriter.Write(b)
	}
	return w.zw.Write(b)
}

func (w *gzipResponseWriter) WriteString(s string) (int, error) { return w.Write([]byte(s)) }

func (w *gzipResponseWriter) Flush() {
	if w.zw != nil {
		_ = w.zw.Flush()
	}
	w.ResponseWriter.Flush()
}

func (w *gzipResponseWriter) close() {
	if w.zw == nil {
		return
	}
	_ = w.zw.Close()
	w.zw.Reset(io.Discard)
	gzipWriters.Put(w.zw)
	w.zw = nil
}
