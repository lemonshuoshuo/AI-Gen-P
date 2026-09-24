// Package webui embeds the built web frontend (internal/webui/dist).
// Build the frontend and copy its output into dist/ before compiling the
// server to ship a single binary; without it the server shows a notice page.
package webui

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// FS returns the frontend files rooted at dist/.
func FS() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err)
	}
	return sub
}
