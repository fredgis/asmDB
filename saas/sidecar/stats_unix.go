//go:build !windows

package main

import (
	"os"
	"syscall"
)

func statFileUsage(path string) (fileUsage, error) {
	info, err := os.Stat(path)
	if err != nil {
		return fileUsage{}, err
	}
	usage := fileUsage{apparent: uint64(info.Size())}
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		allocated := uint64(st.Blocks) * 512
		usage.allocated = &allocated
	}
	return usage, nil
}
