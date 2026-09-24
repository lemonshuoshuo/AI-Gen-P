package handler

import (
	"bytes"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// serveUploads serves user files from DATA_DIR/uploads (no directory listing).
func (h *Handler) serveUploads(c *gin.Context) {
	rel := path.Clean("/" + c.Param("filepath"))[1:]
	if rel == "" || strings.HasPrefix(rel, ".") || strings.Contains(rel, "/.") {
		c.String(http.StatusNotFound, "404 not found")
		return
	}
	f, err := os.Open(filepath.Join(h.svc.Media.Root(), filepath.FromSlash(rel)))
	if err != nil {
		c.String(http.StatusNotFound, "404 not found")
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		c.String(http.StatusNotFound, "404 not found")
		return
	}
	hd := c.Writer.Header()
	hd.Set("Cache-Control", "public, max-age=31536000, immutable")
	hd.Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(c.Writer, c.Request, st.Name(), st.ModTime(), f)
}

const notBuiltPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TripHub</title>
<style>body{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f6f7f9;color:#333;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#fff;border-radius:12px;padding:32px 40px;box-shadow:0 2px 12px rgba(0,0,0,.06);max-width:480px}
h1{font-size:22px;margin:0 0 12px}code{background:#f0f0f0;padding:2px 6px;border-radius:4px}</style></head>
<body><div class="card"><h1>TripHub 服务已启动</h1>
<p>网页前端尚未构建，因此这里暂时没有页面。</p>
<p>请在 <code>web/</code> 目录构建前端，并将产物复制到 <code>server/internal/webui/dist</code> 后重新编译服务端。</p>
<p>API 地址：<code>/api/v1</code>，健康检查：<a href="/api/v1/health">/api/v1/health</a></p></div></body></html>`

// noRoute serves the SPA: static files from the embedded build, falling back
// to index.html for client-side routes. Unknown API paths get a JSON 404.
func (h *Handler) noRoute(c *gin.Context) {
	p := c.Request.URL.Path
	if strings.HasPrefix(p, "/api/") || p == "/api" {
		abortJSON(c, http.StatusNotFound, "not_found", "接口不存在")
		return
	}
	if c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead {
		c.String(http.StatusNotFound, "404 not found")
		return
	}
	if strings.HasPrefix(p, "/uploads/") {
		c.String(http.StatusNotFound, "404 not found")
		return
	}
	name := strings.TrimPrefix(path.Clean(p), "/")
	if h.webui != nil && name != "" && !strings.HasPrefix(name, ".") && !strings.Contains(name, "/.") {
		if h.serveEmbedded(c, name) {
			return
		}
		// Missing hashed assets should 404 rather than return index.html.
		if strings.HasPrefix(name, "assets/") {
			c.String(http.StatusNotFound, "404 not found")
			return
		}
	}
	c.Header("Cache-Control", "no-cache")
	if h.webui != nil {
		if data, err := fs.ReadFile(h.webui, "index.html"); err == nil {
			c.Data(http.StatusOK, "text/html; charset=utf-8", data)
			return
		}
	}
	c.Data(http.StatusOK, "text/html; charset=utf-8", []byte(notBuiltPage))
}

func (h *Handler) serveEmbedded(c *gin.Context, name string) bool {
	f, err := h.webui.Open(name)
	if err != nil {
		return false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		return false
	}
	rs, ok := f.(io.ReadSeeker)
	if !ok {
		return false
	}
	switch {
	case strings.HasPrefix(name, "assets/"):
		c.Header("Cache-Control", "public, max-age=31536000, immutable")
	case name == "index.html":
		c.Header("Cache-Control", "no-cache")
	default:
		c.Header("Cache-Control", "public, max-age=3600")
	}
	if ctype, ok := compressibleAssets[path.Ext(name)]; ok {
		c.Header("Content-Type", ctype)
		addVary(c.Writer.Header(), "Accept-Encoding")
		// Range requests keep the identity encoding.
		if c.GetHeader("Range") == "" && acceptsGzip(c.GetHeader("Accept-Encoding")) {
			if gz := h.gzAsset(name); gz != nil {
				c.Header("Content-Encoding", "gzip")
				c.Header("Content-Length", strconv.Itoa(len(gz)))
				http.ServeContent(c.Writer, c.Request, st.Name(), time.Time{}, bytes.NewReader(gz))
				return true
			}
		}
	}
	http.ServeContent(c.Writer, c.Request, st.Name(), time.Time{}, rs)
	return true
}
