package main

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

func registerStatic(mux *http.ServeMux, siteDir string) {
	fileServer := http.FileServer(http.Dir(siteDir))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			http.ServeFile(w, r, filepath.Join(siteDir, "index.html"))
			return
		}
		cleanPath := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		filePath := filepath.Join(siteDir, cleanPath)
		if info, err := os.Stat(filePath); err == nil && !info.IsDir() {
			fileServer.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
	})
}
