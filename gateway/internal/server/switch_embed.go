package server

import (
	"embed"
	"io/fs"
)

//go:embed all:switch_dist
var switchDistRaw embed.FS

func switchDistFS() fs.FS {
	sub, err := fs.Sub(switchDistRaw, "switch_dist")
	if err != nil {
		return nil
	}
	return sub
}
